/**
 * The web view: one page (bench/ui/index.html) over a small JSON API, live
 * while an experiment runs. `export` inlines the same data into the page, so
 * one self-contained HTML file shows an experiment anywhere.
 *
 *   GET /api/exps                 every experiment, with run counts
 *   GET /api/exps/:exp            report: arms, tasks, comparisons, runs
 *   GET /api/exps/:exp/runs/:id   one run: record, timeline, diff
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import type { AgentEvent } from "./agents.js";
import { buildReport } from "./report.js";
import { expDir, listRuns, runDir, type RunRecord } from "./runner.js";
import { loadSuite } from "./suite.js";
import { BENCH_HOME, REPO_ROOT, readJson } from "./util.js";

const PAGE = () => readFileSync(join(REPO_ROOT, "bench", "ui", "index.html"), "utf8");

function experiments() {
  const dir = join(BENCH_HOME, "exps");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((e) => existsSync(join(dir, e, "exp.json")))
    .map((e) => {
      const spec = readJson<{ exp: string; createdAt: string } & Record<string, unknown>>(join(dir, e, "exp.json"));
      const runs = listRuns(e);
      return { ...spec, runs: runs.length, done: runs.filter((r) => r.status === "done").length, running: runs.filter((r) => r.status === "running").length };
    })
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

function expView(exp: string) {
  const report = buildReport(exp);
  const suite = loadSuite(report.exp.suite);
  const tasks = Object.fromEntries(suite.tasks.map((t) => [t.id, { title: t.title, category: t.category, prompt: t.prompt, historyNote: t.historyNote, asOf: t.asOf, base: t.base, gold: t.gold }]));
  return { ...report, taskSpecs: tasks };
}

function runView(exp: string, runId: string) {
  const dir = runDir(exp, runId);
  if (!existsSync(join(dir, "run.json"))) return null;
  const run = readJson<RunRecord>(join(dir, "run.json"));
  const events: AgentEvent[] = existsSync(join(dir, "events.jsonl"))
    ? readFileSync(join(dir, "events.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as AgentEvent)
    : [];
  const diff = existsSync(join(dir, "diff.patch")) ? readFileSync(join(dir, "diff.patch"), "utf8").slice(0, 300_000) : "";
  return { run, events, diff };
}

export function startServer(port: number): Promise<string> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const json = (data: unknown, code = 200) => {
      res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify(data));
    };
    try {
      const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
      if (parts[0] !== "api") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        return res.end(PAGE());
      }
      if (parts.length === 2 && parts[1] === "exps") return json(experiments());
      if (parts.length === 3 && parts[1] === "exps") return existsSync(expDir(parts[2]!)) ? json(expView(parts[2]!)) : json({ error: "no such experiment" }, 404);
      if (parts.length === 5 && parts[1] === "exps" && parts[3] === "runs") {
        const v = runView(parts[2]!, parts[4]!);
        return v ? json(v) : json({ error: "no such run" }, 404);
      }
      json({ error: "not found" }, 404);
    } catch (e) {
      json({ error: (e as Error).message }, 500);
    }
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(`http://127.0.0.1:${port}`)));
}

/** One file: the page with the experiment, and every run's timeline and diff, inlined. */
export function exportHtml(exp: string): string {
  const view = expView(exp);
  const runs = Object.fromEntries(view.runs.map((r) => [r.runId, runView(exp, r.runId)]));
  const data = JSON.stringify({ exps: experiments().filter((e) => e.exp === exp), view, runs }).replace(/</g, "\\u003c");
  return PAGE().replace("<!--BENCH-DATA-->", `<script>window.__BENCH__ = ${data};</script>`);
}
