#!/usr/bin/env node
/**
 * Judged eval, step 1 of 3: pool the sessions to judge.
 *
 * The mined labels count an earlier session as relevant only when it edited
 * files the query's session goes on to edit. That undercounts: a session that
 * explains the same bug, or settled the design being asked about, is a miss.
 * So an independent judge grades every (query, session) pair that any
 * compared setting ranked in its top k (TREC-style pooling): unjudged pairs
 * cannot exist for the settings compared.
 *
 * Each session is shown to the judge as a card built from its outcome record
 * AS OF THE QUERY'S TIME (point-in-time, like the eval), so the judge cannot
 * see work the session did after the question was asked.
 *
 * Usage: npx tsx scripts/judge-pool.ts --real <root> --cells <cell.json>[,<cell.json>...] [--k 5] [--out <root>/judge-pool.jsonl]
 * Pairs already in the pool file are kept; only new ones are added.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createApp, closeApp } from "../src/app.js";
import { sessionOutcome, syncNow } from "../src/commands.js";
import type { SessionOutcome } from "../src/outcomes/outcome.js";

const args = process.argv.slice(2);
const value = (n: string) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};
const root = value("--real");
const cellFiles = value("--cells")?.split(",").filter(Boolean) ?? [];
if (!root || cellFiles.length === 0) throw new Error("usage: judge-pool --real <root> --cells a.json,b.json [--k 5]");
const k = Number(value("--k") ?? 5);
const out = value("--out") ?? join(root, "judge-pool.jsonl");

interface Golden { id: string; query: string; asOf: string; project: string }
interface QueryResult { id: string; topSessionIds: string[] }
export interface PoolPair { qid: string; query: string; asOf: string; sessionId: string; harness: string; card: string }

const golden = new Map((JSON.parse(readFileSync(join(root, "golden-merged.json"), "utf8")) as Golden[]).map((g) => [g.id, g]));
const wanted = new Map<string, Set<string>>();
for (const f of cellFiles) {
  const saved = JSON.parse(readFileSync(f, "utf8"));
  for (const run of Array.isArray(saved) ? saved : [saved]) {
    for (const q of run.queryResults as QueryResult[]) {
      const set = wanted.get(q.id) ?? new Set<string>();
      for (const s of q.topSessionIds.slice(0, k)) set.add(s);
      wanted.set(q.id, set);
    }
  }
}

const existing = new Set<string>();
const lines: string[] = [];
if (existsSync(out)) {
  for (const l of readFileSync(out, "utf8").split("\n").filter(Boolean)) {
    const p = JSON.parse(l) as PoolPair;
    existing.add(`${p.qid}|${p.sessionId}`);
    lines.push(l);
  }
}

/** What the judge reads about an earlier session: copied fields only, capped. */
function card(o: SessionOutcome): string {
  const tasks = o.tasks
    .filter((t) => t.request)
    .slice(0, 12)
    .map((t) => `- ${t.request!.text.replace(/\s+/g, " ").slice(0, 220)} [${t.status}${t.edits.files.length ? `; files: ${t.edits.files.slice(-4).join(", ")}` : ""}]`);
  return [
    `Project: ${o.project}. Started ${o.startedAt.slice(0, 10)}. ${o.tasks.length} task(s).`,
    "Requests in this session:",
    ...tasks,
    o.edits.files.length ? `Files edited: ${o.edits.files.join(", ")}` : "Files edited: none",
    o.finalReply ? `Agent's last message: ${o.finalReply.text}` : "",
  ]
    .filter(Boolean)
    .join("\n")
    .slice(0, 3500);
}

const run = join(root, "judge-run");
const dead = (n: string) => {
  const d = join(run, n);
  mkdirSync(d, { recursive: true });
  return d;
};
// The eval's own index and state: cards are read, nothing is re-synced beyond a no-op.
const app = createApp({
  stateDir: join(root, "state"), indexDir: join(root, "index"),
  claudeDir: join(root, "claude"), codexDir: join(root, "codex"),
  cursorDb: dead("empty-cursor"), zepDir: dead("empty-zep"), opencodeDb: dead("empty-opencode"), trajectoryDir: dead("empty-trajectories"), gitRepos: [],
});
try {
  await syncNow(app);
  let added = 0;
  for (const [qid, sessions] of wanted) {
    const g = golden.get(qid);
    if (!g) continue;
    for (const sessionId of sessions) {
      if (existing.has(`${qid}|${sessionId}`)) continue;
      let o: SessionOutcome | null = null;
      let harness = "";
      for (const h of ["claude-code", "codex"]) {
        try {
          o = await sessionOutcome(app, h, sessionId, { asOf: g.asOf });
          harness = h;
          break;
        } catch {
          // not this harness
        }
      }
      if (!o) continue;
      lines.push(JSON.stringify({ qid, query: g.query.slice(0, 3000), asOf: g.asOf, sessionId, harness, card: card(o) } satisfies PoolPair));
      existing.add(`${qid}|${sessionId}`);
      added += 1;
    }
  }
  writeFileSync(out, lines.join("\n") + "\n");
  console.log(`pool: ${lines.length} pairs (${added} new) over ${wanted.size} queries -> ${out}`);
} finally {
  await closeApp(app);
}
