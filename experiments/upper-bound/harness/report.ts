/**
 * Summarises results.jsonl from run.ts: per task and arm, then each arm against the baseline.
 *
 *   tsx experiments/upper-bound/harness/report.ts <results-dir> [--baseline control]
 *
 * Writes <results-dir>/report.md and prints it.
 *
 * Bar to continue (README): ≥ 15% faster or cheaper, or materially better completion
 * of trap tasks. "Materially better" here means the 95% bootstrap interval of the
 * pass-rate difference lies above zero.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { RunResult } from "./run.js";

const HERE = dirname(fileURLToPath(import.meta.url));

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
export function median(xs: number[]): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function quantile(sorted: number[], q: number) {
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

/** Bootstrap 95% interval of stat(b) - stat(a) (or stat(b)/stat(a) - 1 when relative). */
export function bootstrapDiff(a: number[], b: number[], stat: (xs: number[]) => number, { relative = false, iterations = 10000, seed = 7 } = {}) {
  const point = relative ? stat(b) / stat(a) - 1 : stat(b) - stat(a);
  if (a.length < 2 || b.length < 2) return { point, low: NaN, high: NaN };
  const rand = mulberry32(seed);
  const pick = (xs: number[]) => Array.from({ length: xs.length }, () => xs[Math.floor(rand() * xs.length)]);
  const draws: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const sa = stat(pick(a));
    const sb = stat(pick(b));
    const d = relative ? sb / sa - 1 : sb - sa;
    if (Number.isFinite(d)) draws.push(d);
  }
  draws.sort((x, y) => x - y);
  return { point, low: quantile(draws, 0.025), high: quantile(draws, 0.975) };
}

const pct = (x: number) => (Number.isFinite(x) ? `${(x * 100).toFixed(0)}%` : "n/a");
const signedPct = (x: number) => (Number.isFinite(x) ? `${x >= 0 ? "+" : ""}${(x * 100).toFixed(0)}%` : "n/a");
const pp = (x: number) => (Number.isFinite(x) ? `${x >= 0 ? "+" : ""}${(x * 100).toFixed(0)} pts` : "n/a");
const ci = (r: { low: number; high: number }, f: (x: number) => string) => (Number.isFinite(r.low) ? `[${f(r.low)}, ${f(r.high)}]` : "");
const money = (x: number) => (Number.isFinite(x) ? `$${x.toFixed(2)}` : "n/a");
const secs = (ms: number) => (Number.isFinite(ms) ? `${Math.round(ms / 1000)}s` : "n/a");

function loadSpec(task: string): { signals?: Record<string, string>; grade?: { labels?: Record<string, string> } } {
  const f = resolve(HERE, "..", "tasks", task, "task.json");
  return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : {};
}

export function buildReport(all: RunResult[], baseline = "control"): string {
  const lines: string[] = ["# Upper-bound experiment report", ""];
  const results = all.filter((r) => !r.invalid);
  const invalid = all.filter((r) => r.invalid);
  if (invalid.length) {
    lines.push(`**${invalid.length} invalid run(s) left out**: the agent failed before attempting the task. Fix the cause and re-run them.`, "");
    for (const r of invalid) lines.push(`- ${r.task} / ${r.arm} / rep ${r.rep}: ${r.invalid}`);
    lines.push("");
  }
  const tasks = [...new Set(results.map((r) => r.task))];
  const armsOrder = [...new Set(results.map((r) => r.arm))];
  lines.push(`Runs: ${results.length}. Tasks: ${tasks.join(", ")}. Arms: ${armsOrder.join(", ")}. Baseline: ${baseline}.`, "");

  for (const task of tasks) {
    const spec = loadSpec(task);
    const signals = spec.signals ?? {};
    const rows = results.filter((r) => r.task === task);
    lines.push(`## ${task}`, "");
    const sigCols = Object.keys(signals);
    lines.push(
      `| Arm | n | Pass | Trap hit | Goal met | Median time | Mean cost | Mean turns | Runs shown notes | ${sigCols.join(" | ")}${sigCols.length ? " |" : ""}`,
      `|---|---|---|---|---|---|---|---|---|${sigCols.map(() => "---|").join("")}`,
    );
    for (const arm of armsOrder) {
      const rs = rows.filter((r) => r.arm === arm);
      if (!rs.length) continue;
      const costs = rs.map((r) => r.costUsd).filter((x): x is number => typeof x === "number");
      const turns = rs.map((r) => r.numTurns).filter((x): x is number => typeof x === "number");
      const sig = sigCols.map((k) => pct(mean(rs.map((r) => (r.readPaths ?? []).includes(signals[k]) ? 1 : 0))));
      lines.push(
        `| ${arm} | ${rs.length} | ${pct(mean(rs.map((r) => +r.pass)))} | ${pct(mean(rs.map((r) => +r.trapHit)))} | ${pct(mean(rs.map((r) => +r.goal)))} | ${secs(median(rs.map((r) => r.durationMs)))} | ${money(mean(costs))} | ${Number.isFinite(mean(turns)) ? mean(turns).toFixed(1) : "n/a"} | ${pct(mean(rs.map((r) => (r.notesShown.length || r.pullCalls ? 1 : 0))))} | ${sig.join(" | ")}${sig.length ? " |" : ""}`,
      );
    }
    lines.push("");
    if (sigCols.length) lines.push(`Signal columns: share of runs that read ${sigCols.map((k) => `\`${signals[k]}\` (${k})`).join(", ")}.`, "");

    // Each grader check on its own: which part of the job each arm gets right.
    const checks = Object.entries(spec.grade?.labels ?? {}).filter(([k]) => k !== "visible" && k !== "goal" && rows.some((r) => typeof r.grade?.[k] === "boolean"));
    if (checks.length) {
      lines.push(`| Arm | ${checks.map(([, label]) => label).join(" | ")} |`, `|---|${checks.map(() => "---|").join("")}`);
      for (const arm of armsOrder) {
        const rs = rows.filter((r) => r.arm === arm);
        if (rs.length) lines.push(`| ${arm} | ${checks.map(([k]) => pct(mean(rs.map((r) => (r.grade?.[k] === true ? 1 : 0))))).join(" | ")} |`);
      }
      lines.push("");
    }

    const base = rows.filter((r) => r.arm === baseline);
    if (!base.length) {
      lines.push(`No "${baseline}" runs for this task, so no comparison.`, "");
      continue;
    }
    lines.push(`### Against ${baseline}`, "", "| Arm | Pass rate | Mean cost | Median time | Verdict |", "|---|---|---|---|---|");
    for (const arm of armsOrder) {
      if (arm === baseline) continue;
      const rs = rows.filter((r) => r.arm === arm);
      if (!rs.length) continue;
      const passD = bootstrapDiff(base.map((r) => +r.pass), rs.map((r) => +r.pass), mean);
      const bc = base.map((r) => r.costUsd).filter((x): x is number => typeof x === "number");
      const ac = rs.map((r) => r.costUsd).filter((x): x is number => typeof x === "number");
      const costD = bootstrapDiff(bc, ac, mean, { relative: true });
      const timeD = bootstrapDiff(base.map((r) => r.durationMs), rs.map((r) => r.durationMs), median, { relative: true });
      const verdict: string[] = [];
      if (passD.low > 0) verdict.push("better completion");
      if (passD.high < 0) verdict.push("worse completion");
      if (costD.point <= -0.15 && costD.high < 0) verdict.push("≥15% cheaper");
      if (timeD.point <= -0.15 && timeD.high < 0) verdict.push("≥15% faster");
      // Finishing sooner or cheaper only counts when the arm gets the work done: an arm that always fails fast is not a saving.
      const passes = rs.some((r) => r.pass);
      if (!passes && verdict.some((v) => v.startsWith("≥15%"))) verdict.push("but never passes");
      const meets = (verdict.includes("better completion") || (passes && verdict.some((v) => v.startsWith("≥15%")))) && !verdict.includes("worse completion");
      lines.push(
        `| ${arm} | ${pp(passD.point)} ${ci(passD, pp)} | ${signedPct(costD.point)} ${ci(costD, signedPct)} | ${signedPct(timeD.point)} ${ci(timeD, signedPct)} | ${meets ? "**meets the bar**" : verdict.length ? verdict.join(", ") : "inconclusive"} |`,
      );
    }
    lines.push("", "Intervals are 95% bootstrap intervals. With fewer than about 10 runs per arm they are wide; add reps before reading much into them.", "");
  }
  return lines.join("\n");
}

function main(argv: string[]) {
  const dir = argv.find((a) => !a.startsWith("--"));
  if (!dir) {
    console.error("usage: report.ts <results-dir> [--baseline control]");
    process.exit(2);
  }
  const i = argv.indexOf("--baseline");
  const baseline = i >= 0 ? argv[i + 1] : "control";
  const results = readFileSync(join(dir, "results.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as RunResult);
  const md = buildReport(results, baseline);
  writeFileSync(join(dir, "report.md"), md + "\n");
  console.log(md);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
