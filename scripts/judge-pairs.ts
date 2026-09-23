#!/usr/bin/env node
/**
 * Judged eval, step 2 of 3: grade the pooled pairs with an independent judge.
 *
 * The judge is Claude run headless through the Claude Code CLI (`claude -p`),
 * so no API key is needed: it uses the machine's Claude login. It is not Jev
 * and not Voyage, the components under test, so it cannot favour them.
 * `--cli agy` runs Gemini through the Antigravity CLI (`agy -p`) instead, on
 * the operator's agy key, to spare the Claude quota.
 *
 * Safeguards, all required:
 *   --no-session-persistence  no transcript is written to ~/.claude/projects,
 *                             which the gateway itself indexes (judge prompts
 *                             hold other people's history and eval queries)
 *   --tools ""                the judge reads and grades, nothing else
 *   --strict-mcp-config       no MCP servers, so not this gateway's either
 * agy has no such flags: it runs --sandbox in an empty directory. It keeps
 * every conversation under ~/.gemini/antigravity-cli (not indexed by the
 * gateway); their ids are appended to <out>.agy-conversations to find them.
 *
 * Grades, per pair: 2 = an agent starting the new request would directly
 * benefit (same problem, feature or code, or the decision it needs); 1 =
 * related area, some useful context; 0 = not useful. Grades are cached in the
 * judgments file: a pair is judged once, later experiments judge only new ones.
 * A grade is kept only for the card it was given on (cardHash): rebuild the
 * cards and every changed pair is judged again.
 *
 * Usage: npx tsx scripts/judge-pairs.ts --pool <pool.jsonl> --out <judgments.jsonl> [--batch 12] [--batch-chars 60000] [--cli claude|agy] [--model haiku] [--limit N]
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";

const args = process.argv.slice(2);
const value = (n: string) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};
const poolFile = value("--pool");
const out = value("--out");
if (!poolFile || !out) throw new Error("usage: judge-pairs --pool <pool.jsonl> --out <judgments.jsonl>");
const batchSize = Number(value("--batch") ?? 12);
const batchChars = Number(value("--batch-chars") ?? 60_000);
const cli = value("--cli") ?? "claude";
if (cli !== "claude" && cli !== "agy") throw new Error("--cli is claude or agy");
const model = value("--model") ?? (cli === "agy" ? "gemini-3.8-flash-high" : "haiku");
const limit = Number(value("--limit") ?? Infinity);

interface PoolPair { qid: string; query: string; asOf: string; sessionId: string; harness: string; card: string }
interface Judgment { qid: string; sessionId: string; grade: 0 | 1 | 2; model: string; cardHash?: string }
const hash = (card: string) => createHash("sha1").update(card).digest("hex").slice(0, 12);

const pool = readFileSync(poolFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as PoolPair);
const done = new Set<string>();
if (existsSync(out)) {
  for (const l of readFileSync(out, "utf8").split("\n").filter(Boolean)) {
    const j = JSON.parse(l) as Judgment;
    done.add(`${j.qid}|${j.sessionId}|${j.cardHash ?? ""}`);
  }
}
const pending = pool.filter((p) => !done.has(`${p.qid}|${p.sessionId}|${hash(p.card)}`));
const todo = pending.slice(0, limit);

// Batches share one query where possible: the judge reads the request once.
todo.sort((a, b) => a.qid.localeCompare(b.qid));
const batches: PoolPair[][] = [];
for (const p of todo) {
  const last = batches[batches.length - 1];
  const chars = last ? last.reduce((n, x) => n + x.card.length, 0) + p.card.length : 0;
  if (last && last.length < batchSize && chars <= batchChars && last[0]!.qid === p.qid) last.push(p);
  else batches.push([p]);
}

const RUBRIC = `You grade search results for a tool that finds earlier AI coding-agent sessions.
A developer is starting a NEW agent session with the request below. For each EARLIER
session, judge: would giving the new agent this earlier session help it with the request?
  2 = directly useful: same problem, bug, feature or code area, or it holds a decision or
      fix the new request depends on
  1 = related: same part of the project, some useful background
  0 = not useful for this request
Judge usefulness for the request, not surface word overlap. Reply with ONLY a JSON array,
one object per earlier session, in order: [{"id":"<id>","grade":0|1|2}]`;

// A private working directory, removed afterwards: the CLI creates a
// per-directory folder under ~/.claude/projects even without persistence.
// realpath: the CLI names the folder after the resolved path (/private/var/... on macOS).
const cwd = realpathSync(mkdtempSync(join(tmpdir(), "acg-judge-")));
const projectsDir = join(homedir(), ".claude", "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));
const cleanUp = () => {
  rmSync(cwd, { recursive: true, force: true });
  if (existsSync(projectsDir) && basename(projectsDir).includes("acg-judge-")) rmSync(projectsDir, { recursive: true, force: true });
};
// Also when stopped part-way: the folders would otherwise be left behind.
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, () => (cleanUp(), process.exit(130)));

let judged = 0;
let failed = 0;
for (const [i, batch] of batches.entries()) {
  const prompt = [
    RUBRIC,
    "",
    "NEW REQUEST:",
    batch[0]!.query,
    "",
    ...batch.map((p, j) => `EARLIER SESSION id=s${j}\n${p.card}\n`),
  ].join("\n");
  const r =
    cli === "agy"
      ? spawnSync("agy", ["--output-format", "json", "--model", model, "--sandbox", "--disable-slash-commands", "-p", prompt], {
          cwd,
          encoding: "utf8",
          timeout: 300_000,
          maxBuffer: 16 * 1024 * 1024,
        })
      : spawnSync("claude", ["-p", "--no-session-persistence", "--tools", "", "--strict-mcp-config", "--model", model, "--output-format", "json"], {
          input: prompt,
          cwd,
          encoding: "utf8",
          timeout: 180_000,
          maxBuffer: 16 * 1024 * 1024,
        });
  let grades: { id: string; grade: number }[] | null = null;
  try {
    const envelope = JSON.parse(r.stdout) as { result?: string; response?: string; conversation_id?: string };
    if (envelope.conversation_id) appendFileSync(`${out}.agy-conversations`, envelope.conversation_id + "\n");
    const m = /\[[\s\S]*\]/.exec(envelope.result ?? envelope.response ?? "");
    grades = m ? (JSON.parse(m[0]) as { id: string; grade: number }[]) : null;
  } catch {
    grades = null;
  }
  if (!grades) {
    failed += batch.length;
    console.error(`batch ${i + 1}/${batches.length}: unparseable reply, skipped (rerun to retry)`);
    continue;
  }
  for (const [j, p] of batch.entries()) {
    const g = grades.find((x) => x.id === `s${j}`)?.grade;
    if (g !== 0 && g !== 1 && g !== 2) {
      failed += 1;
      continue;
    }
    appendFileSync(out, JSON.stringify({ qid: p.qid, sessionId: p.sessionId, grade: g, model, cardHash: hash(p.card) } satisfies Judgment) + "\n");
    judged += 1;
  }
  if ((i + 1) % 10 === 0) console.error(`batch ${i + 1}/${batches.length}: ${judged} judged, ${failed} to retry`);
}
cleanUp();
console.log(`judged ${judged} pairs (${failed} to retry) of ${todo.length} taken; ${pool.length - pending.length} were already judged, ${pending.length - todo.length} left by --limit -> ${out}`);
