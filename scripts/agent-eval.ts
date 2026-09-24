#!/usr/bin/env node
/**
 * Agent-in-the-loop eval: does an agent that USES the gateway pick the right
 * earlier sessions, and what does it cost it?
 *
 * Retrieval metrics grade the ranking; payload grading (run-eval
 * --save-payloads) grades what one search hands over. Neither sees what an
 * agent does next: open a hit, search again, or stop. Here a model plays the
 * agent. Per golden query it gets the task, calls the gateway's tools through
 * HTTP (search, and open for a hit's turn window), at most --max-tools times,
 * then names the earlier sessions it would rely on, most useful first, and
 * notes what from them matters. Each step is one stateless model call that
 * sees the whole transcript so far.
 *
 * Modes differ only in what search returns: `full` (turn windows) or
 * `compact` (summaries, outcomes and task digests; open to read more).
 *
 * The model runs through the Antigravity CLI (`agy -p`, Gemini) in an empty
 * sandboxed directory, as judge-pairs.ts --cli agy does; conversation ids go
 * to <out>.agy-conversations for cleanup. The gateway is eval-serve.ts on the
 * eval corpus (usually the VM, through an ssh tunnel).
 *
 * Run:   npx tsx scripts/agent-eval.ts --gateway http://127.0.0.1:8787 --golden golden-merged.json
 *          --modes compact,full --out runs.jsonl [--qids file] [--limit N] [--concurrency 4] [--max-tools 4]
 * Score: npx tsx scripts/agent-eval.ts --score runs.jsonl --judgments a.jsonl[,b.jsonl] [--cells-out prefix]
 *   --cells-out writes, per mode, a cell of the sessions the agent picked, for
 *   judge-pool.ts, so picks nobody graded yet can be judged.
 */
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const value = (n: string) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};

interface Golden { id: string; query: string; asOf: string; project?: string; harness?: string }
interface Step { action: Record<string, unknown>; result?: string; ms: number }
interface Run {
  qid: string;
  mode: string;
  picks: string[];
  notes: string;
  steps: Step[];
  searches: number;
  opens: number;
  /** Characters of tool output the agent read. */
  toolChars: number;
  /** Characters of every prompt sent (the transcript is re-sent each step). */
  promptChars: number;
  wallMs: number;
  error?: string;
}

async function run() {
  const gateway = value("--gateway") ?? "http://127.0.0.1:8787";
  const goldenPath = value("--golden");
  const out = value("--out");
  if (!goldenPath || !out) throw new Error("usage: agent-eval --gateway <url> --golden <golden.json> --out <runs.jsonl>");
  const modes = (value("--modes") ?? "compact,full").split(",").filter(Boolean);
  const maxTools = Number(value("--max-tools") ?? 4);
  const concurrency = Number(value("--concurrency") ?? 4);
  const model = value("--model") ?? "gemini-3.8-flash-high";
  let golden = JSON.parse(readFileSync(goldenPath, "utf8")) as Golden[];
  const qidsFile = value("--qids");
  if (qidsFile) {
    const keep = new Set(readFileSync(qidsFile, "utf8").split("\n").map((s) => s.trim()).filter(Boolean));
    golden = golden.filter((g) => keep.has(g.id));
  }
  golden = golden.slice(0, Number(value("--limit") ?? Infinity));
  const done = new Set<string>();
  if (existsSync(out)) {
    for (const l of readFileSync(out, "utf8").split("\n").filter(Boolean)) {
      const r = JSON.parse(l) as Run;
      if (!r.error) done.add(`${r.qid}|${r.mode}`);
    }
  }
  const jobs = golden.flatMap((g) => modes.map((mode) => ({ g, mode }))).filter((j) => !done.has(`${j.g.id}|${j.mode}`));
  console.error(`${jobs.length} runs (${done.size} already done), ${concurrency} at a time`);
  const cwd = mkdtempSync(join(tmpdir(), "acg-agent-eval-"));
  let next = 0;
  let finished = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const { g, mode } = jobs[next++]!;
      const r = await episode(g, mode, { gateway, maxTools, model, cwd, out });
      appendFileSync(out, JSON.stringify(r) + "\n");
      finished += 1;
      console.error(`[${finished}/${jobs.length}] ${g.id} ${mode}: ${r.error ?? `${r.picks.length} picked, ${r.searches}s/${r.opens}o, ${Math.round(r.toolChars / 4)} tok read`}`);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  rmSync(cwd, { recursive: true, force: true });
}

const INSTRUCTIONS = (g: Golden, maxTools: number) => `You are a coding agent about to start the TASK below${g.project ? ` in project "${g.project}"` : ""}.
Earlier AI agent sessions in this project may hold work, decisions or fixes that help.
Before you start, you may consult them through tools. Reply with exactly ONE JSON object and nothing else:

{"tool":"search","query":"<what to look for>"}
    search the earlier sessions; returns JSON results (each has provenance.harness, provenance.sessionId, provenance.turnId)
{"tool":"open","harness":"<harness>","sessionId":"<id>","turnId":"<turn id>"}
    read the turns around one search result
{"tool":"final","useful":["<sessionId>", ...],"notes":"<at most 80 words>"}
    finish: the earlier sessions you would rely on for the task, most useful first ([] if none helps),
    and what from them matters for the task

You have at most ${maxTools} search/open calls; then you must finish. Stop as soon as you know enough.
Only name sessions you actually saw in results.

TASK:
${g.query.slice(0, 3000)}`;

async function episode(g: Golden, mode: string, o: { gateway: string; maxTools: number; model: string; cwd: string; out: string }): Promise<Run> {
  const r: Run = { qid: g.id, mode, picks: [], notes: "", steps: [], searches: 0, opens: 0, toolChars: 0, promptChars: 0, wallMs: 0 };
  const t0 = Date.now();
  const transcript: string[] = [];
  const seen = new Set<string>();
  try {
    for (let step = 0; step <= o.maxTools; step++) {
      const last = step === o.maxTools;
      const prompt = [
        INSTRUCTIONS(g, o.maxTools),
        "",
        transcript.length ? `SO FAR:\n${transcript.join("\n")}` : "",
        last ? "You have no tool calls left: reply with the final JSON now." : "Your next JSON:",
      ].join("\n");
      r.promptChars += prompt.length;
      const s0 = Date.now();
      const action = await ask(prompt, o);
      const kind = last ? "final" : String(action?.tool ?? "final");
      if (kind === "search" && typeof action?.query === "string") {
        const qs = new URLSearchParams({ q: action.query, asOf: g.asOf, maxResults: "5", compact: String(mode === "compact") });
        if (g.project) qs.set("project", g.project);
        if (g.harness) qs.set("harness", g.harness);
        const res = await fetchText(`${o.gateway}/search?${qs}`);
        for (const m of res.matchAll(/"sessionId":\s*"([^"]+)"/g)) seen.add(m[1]!);
        r.searches += 1;
        r.toolChars += res.length;
        r.steps.push({ action: action!, result: res.slice(0, 200), ms: Date.now() - s0 });
        transcript.push(`[${step + 1}] you: ${JSON.stringify(action)}`, `[${step + 1}] result: ${res}`);
        continue;
      }
      if (kind === "open" && action?.harness && action.sessionId && action.turnId) {
        const qs = new URLSearchParams({ window: "3", asOf: g.asOf, query: g.query.slice(0, 500) });
        const path = `/sessions/${encodeURIComponent(String(action.harness))}/${encodeURIComponent(String(action.sessionId))}/turns/${encodeURIComponent(String(action.turnId))}`;
        const res = await fetchText(`${o.gateway}${path}?${qs}`);
        r.opens += 1;
        r.toolChars += res.length;
        r.steps.push({ action: action!, result: res.slice(0, 200), ms: Date.now() - s0 });
        transcript.push(`[${step + 1}] you: ${JSON.stringify(action)}`, `[${step + 1}] result: ${res}`);
        continue;
      }
      // final, or anything unusable: finish with what it named.
      const useful = Array.isArray(action?.useful) ? (action!.useful as unknown[]).map(String) : [];
      r.picks = [...new Set(useful.filter((id) => seen.has(id)))];
      r.notes = typeof action?.notes === "string" ? action.notes.slice(0, 1000) : "";
      r.steps.push({ action: action ?? { tool: "final", unparsed: true }, ms: Date.now() - s0 });
      break;
    }
  } catch (e) {
    r.error = (e as Error).message.slice(0, 300);
  }
  r.wallMs = Date.now() - t0;
  return r;
}

/** A gateway call; a dropped connection (tunnel restart) is retried, an HTTP error is shown to the agent. */
async function fetchText(url: string): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url);
      const text = await res.text();
      if (!res.ok) return `error ${res.status}: ${text.slice(0, 300)}`;
      return text;
    } catch (e) {
      if (attempt >= 5) throw e;
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }
}

/** One model turn through agy; the first JSON object in the reply, or null (one retry). */
async function ask(prompt: string, o: { model: string; cwd: string; out: string }): Promise<Record<string, unknown> | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const stdout = await new Promise<string>((resolve) => {
      const p = spawn("agy", ["--output-format", "json", "--model", o.model, "--sandbox", "--disable-slash-commands", "-p", prompt], { cwd: o.cwd });
      let buf = "";
      p.stdout.on("data", (d) => (buf += d));
      const timer = setTimeout(() => p.kill("SIGTERM"), 300_000);
      p.on("close", () => (clearTimeout(timer), resolve(buf)));
      p.on("error", () => (clearTimeout(timer), resolve("")));
    });
    try {
      const envelope = JSON.parse(stdout) as { response?: string; result?: string; conversation_id?: string };
      if (envelope.conversation_id) appendFileSync(`${o.out}.agy-conversations`, envelope.conversation_id + "\n");
      const text = envelope.response ?? envelope.result ?? "";
      const parsed = firstJsonObject(text);
      if (parsed) return parsed;
    } catch {
      // retry
    }
  }
  return null;
}

function firstJsonObject(text: string): Record<string, unknown> | null {
  for (let i = text.indexOf("{"); i >= 0; i = text.indexOf("{", i + 1)) {
    let depth = 0;
    let inStr = false;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (inStr) {
        if (c === "\\") j++;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) {
        try {
          const v = JSON.parse(text.slice(i, j + 1));
          if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
        } catch {
          // keep looking
        }
        break;
      }
    }
  }
  return null;
}

function score() {
  const runs = readFileSync(value("--score")!, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Run).filter((r) => !r.error);
  const grade = new Map<string, number>();
  for (const f of (value("--judgments") ?? "").split(",").filter(Boolean)) {
    for (const l of readFileSync(f, "utf8").split("\n").filter(Boolean)) {
      const j = JSON.parse(l) as { qid: string; sessionId: string; grade: number };
      grade.set(`${j.qid}|${j.sessionId}`, j.grade);
    }
  }
  // Queries with a known directly useful session (any judged pair graded 2).
  const hasUseful = new Set([...grade].filter(([, g]) => g === 2).map(([k]) => k.slice(0, k.lastIndexOf("|"))));
  // Compare modes on the queries every mode finished.
  const modes = [...new Set(runs.map((r) => r.mode))];
  const byQ = new Map<string, Map<string, Run>>();
  for (const r of runs) byQ.set(r.qid, (byQ.get(r.qid) ?? new Map()).set(r.mode, r));
  const common = [...byQ].filter(([, m]) => modes.every((x) => m.has(x))).map(([q]) => q);
  const med = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] ?? 0;
  const mean = (a: number[]) => a.reduce((n, x) => n + x, 0) / Math.max(1, a.length);
  console.log(`${common.length} queries run in every mode; ${common.filter((q) => hasUseful.has(q)).length} have a judged useful session`);
  console.log("| mode | top pick useful (2) | top pick a lure (0) | found none though one exists | top pick ungraded | searches | opens | tokens read (median) | prompt tokens (median) | wall s (median) |");
  console.log("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
  const cells: Record<string, { queryResults: { id: string; topSessionIds: string[] }[] }> = {};
  for (const mode of modes) {
    const rs = common.map((q) => byQ.get(q)!.get(mode)!);
    const withUseful = rs.filter((r) => hasUseful.has(r.qid));
    const top = (r: Run) => (r.picks[0] ? grade.get(`${r.qid}|${r.picks[0]}`) : undefined);
    const useful = withUseful.filter((r) => top(r) === 2).length;
    const lure = rs.filter((r) => r.picks[0] && top(r) === 0).length;
    const none = withUseful.filter((r) => r.picks.length === 0).length;
    const ungraded = rs.filter((r) => r.picks[0] && top(r) === undefined).length;
    const pct = (n: number, d: number) => `${n}/${d} (${Math.round((100 * n) / Math.max(1, d))}%)`;
    console.log(
      `| ${mode} | ${pct(useful, withUseful.length)} | ${pct(lure, rs.length)} | ${pct(none, withUseful.length)} | ${ungraded} | ${mean(rs.map((r) => r.searches)).toFixed(1)} | ${mean(rs.map((r) => r.opens)).toFixed(1)} | ${Math.round(med(rs.map((r) => r.toolChars / 4)))} | ${Math.round(med(rs.map((r) => r.promptChars / 4)))} | ${(med(rs.map((r) => r.wallMs)) / 1000).toFixed(0)} |`,
    );
    cells[mode] = { queryResults: rs.map((r) => ({ id: r.qid, topSessionIds: r.picks })) };
  }
  const prefix = value("--cells-out");
  if (prefix) for (const [mode, cell] of Object.entries(cells)) writeFileSync(`${prefix}-${mode}.json`, JSON.stringify(cell));
}

if (value("--score")) score();
else await run();
