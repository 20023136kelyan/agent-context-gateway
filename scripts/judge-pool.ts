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
 * Recall check (--recall <qids file>): for the listed queries, also pool
 * every session of the query's project that started before it (newest first,
 * up to --recall-max), whether or not any setting returned it. Graded, these
 * show whether a useful session exists that retrieval never surfaced.
 *
 * Usage: npx tsx scripts/judge-pool.ts --real <root> --cells <cell.json>[,<cell.json>...] [--k 5] [--out <root>/judge-pool.jsonl]
 *        [--recall <qids file> [--recall-max 40]]
 * Pairs already in the pool file are kept; only new ones are added.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createApp, closeApp } from "../src/app.js";
import { listSessions, sessionOutcome, syncNow } from "../src/commands.js";
import type { Session } from "../src/core/models.js";
import type { SessionOutcome } from "../src/outcomes/outcome.js";

const args = process.argv.slice(2);
const value = (n: string) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};
const root = value("--real");
const cellFiles = value("--cells")?.split(",").filter(Boolean) ?? [];
const recallFile = value("--recall");
const recallMax = Number(value("--recall-max") ?? 40);
if (!root || (cellFiles.length === 0 && !recallFile)) throw new Error("usage: judge-pool --real <root> --cells a.json,b.json [--k 5] [--recall qids.txt]");
const k = Number(value("--k") ?? 5);
const out = value("--out") ?? join(root, "judge-pool.jsonl");

interface Golden { id: string; query: string; asOf: string; project: string; mined?: string }
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

/**
 * What the judge reads about an earlier session: copied fields only. Every
 * request is listed, shortened to fit, because the part of a long session that
 * matters to a query is often far from its start; listing only the first few
 * hid it for half the pool. Budgets are in characters.
 */
const CARD_CHARS = 12_000;
const REQUESTS_CHARS = 8_000;
function card(o: SessionOutcome): string {
  const tasks = o.tasks.filter((t) => t.request);
  // Shorten every request (and drop per-task files) until the list fits, so a
  // long session's later requests are never the ones cut.
  const list = (per: number, withFiles: boolean) =>
    tasks.map((t, i) => {
      const text = t.request!.text.replace(/\s+/g, " ");
      const files = withFiles ? t.edits.files.map((f) => f.split("/").pop()).slice(-3) : [];
      return `${i + 1}. ${text.length > per ? `${text.slice(0, per)}…` : text} [${t.status}${files.length ? `; ${files.join(", ")}` : ""}]`;
    });
  let lines = list(220, true);
  for (const [per, withFiles] of [[160, true], [120, true], [90, false], [60, false], [40, false]] as const) {
    if (lines.join("\n").length <= REQUESTS_CHARS) break;
    lines = list(per, withFiles);
  }
  const edited = o.edits.files.map((f) => f.split("/").slice(-2).join("/"));
  return [
    `Project: ${o.project}. Started ${o.startedAt.slice(0, 10)}. ${o.tasks.length} task(s), ${o.edits.count} edit(s).`,
    "Requests in this session, in order:",
    ...lines,
    edited.length ? `Latest files edited: ${edited.join(", ")}` : "Files edited: none",
    o.finalReply ? `Agent's last message: ${o.finalReply.text.replace(/\s+/g, " ").slice(0, 600)}` : "",
  ]
    .filter(Boolean)
    .join("\n")
    .slice(0, CARD_CHARS);
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
  if (recallFile) {
    const byProject = new Map<string, Session[]>();
    for (const qid of readFileSync(recallFile, "utf8").split(/\s+/).filter(Boolean)) {
      const g = golden.get(qid);
      if (!g) continue;
      // The session the query was asked in is not an earlier session.
      const own = /'querySession': '([^']+)'/.exec(g.mined ?? "")?.[1];
      let sessions = byProject.get(g.project);
      if (!sessions) byProject.set(g.project, (sessions = await listSessions(app, { project: g.project })));
      const asOf = Date.parse(g.asOf);
      const earlier = sessions
        .filter((s) => s.id !== own && Date.parse(s.startedAt) < asOf)
        .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
        .slice(0, recallMax);
      const set = wanted.get(qid) ?? new Set<string>();
      for (const s of earlier) set.add(s.id);
      wanted.set(qid, set);
    }
  }
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
