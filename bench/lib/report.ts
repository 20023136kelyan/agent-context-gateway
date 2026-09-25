/**
 * What an experiment shows: per arm, how often the agent passed, how long it
 * took and how many tokens it spent; per task, the same side by side; and a
 * paired comparison of each gateway arm against `none` on the tasks both ran
 * (per task, the median of its repeats; across tasks, the geometric mean of
 * the ratios, so one slow task does not dominate).
 */
import { join } from "node:path";
import { existsSync } from "node:fs";
import { loadSuite, type TaskCategory } from "./suite.js";
import { expDir, listRuns, type ExperimentSpec, type RunRecord } from "./runner.js";
import { median, readJson } from "./util.js";

export interface Cell {
  runs: number;
  passed: number;
  errors: number;
  wallS: number;
  tokens: number;
  inputTokens: number;
  toolCalls: number;
  llmSteps: number;
  gatewayCalls: number;
}

export interface TaskRow {
  taskId: string;
  title: string;
  category: TaskCategory;
  arms: Record<string, Cell>;
}

export interface Comparison {
  arm: string;
  baseline: string;
  tasks: number;
  passBase: number;
  passArm: number;
  runsBase: number;
  runsArm: number;
  /** Geometric mean over tasks of (arm median / baseline median). */
  timeRatio: number;
  tokenRatio: number;
  toolRatio: number;
  faster: number;
  slower: number;
  cheaper: number;
  pricier: number;
  byCategory: Record<string, { tasks: number; timeRatio: number; tokenRatio: number; passBase: number; passArm: number }>;
}

export interface Report {
  exp: ExperimentSpec;
  generatedAt: string;
  arms: (Cell & { arm: string; gatewayLoaded: number })[];
  tasks: TaskRow[];
  comparisons: Comparison[];
  runs: RunRecord[];
}

function cell(runs: RunRecord[]): Cell {
  const done = runs.filter((r) => r.status === "done" && r.metrics);
  return {
    runs: done.length,
    passed: done.filter((r) => r.check?.passed).length,
    errors: runs.filter((r) => r.status === "error").length,
    wallS: median(done.map((r) => r.metrics!.wallMs / 1000)),
    tokens: median(done.map((r) => r.metrics!.tokens.total)),
    inputTokens: median(done.map((r) => r.metrics!.tokens.input)),
    toolCalls: median(done.map((r) => r.metrics!.toolCalls)),
    llmSteps: median(done.map((r) => r.metrics!.llmSteps)),
    gatewayCalls: done.length ? done.reduce((n, r) => n + (r.gatewayServed ?? 0), 0) / done.length : 0,
  };
}

const geo = (xs: number[]) => (xs.length ? Math.exp(xs.reduce((n, x) => n + Math.log(x), 0) / xs.length) : NaN);

export function buildReport(exp: string): Report {
  const specPath = join(expDir(exp), "exp.json");
  if (!existsSync(specPath)) throw new Error(`no experiment "${exp}"`);
  const spec = readJson<ExperimentSpec>(specPath);
  const suite = loadSuite(spec.suite);
  const runs = listRuns(exp);
  const arms = spec.arms.map((arm) => {
    const rs = runs.filter((r) => r.arm === arm);
    return { arm, ...cell(rs), gatewayLoaded: rs.filter((r) => r.gatewayLoaded).length };
  });
  const tasks: TaskRow[] = suite.tasks
    .filter((t) => runs.some((r) => r.taskId === t.id))
    .map((t) => ({
      taskId: t.id,
      title: t.title,
      category: t.category,
      arms: Object.fromEntries(spec.arms.map((arm) => [arm, cell(runs.filter((r) => r.taskId === t.id && r.arm === arm))])),
    }));
  const comparisons: Comparison[] = [];
  const baseline = "none";
  for (const arm of spec.arms.filter((a) => a !== baseline)) {
    const paired = tasks.filter((t) => t.arms[baseline]?.runs && t.arms[arm]?.runs);
    const ratios = (rows: TaskRow[], k: keyof Cell) => rows.map((t) => (t.arms[arm]![k] as number) / Math.max(1e-9, t.arms[baseline]![k] as number)).filter((x) => Number.isFinite(x) && x > 0);
    const byCategory: Comparison["byCategory"] = {};
    for (const cat of [...new Set(paired.map((t) => t.category))]) {
      const rows = paired.filter((t) => t.category === cat);
      byCategory[cat] = {
        tasks: rows.length,
        timeRatio: geo(ratios(rows, "wallS")),
        tokenRatio: geo(ratios(rows, "tokens")),
        passBase: rows.reduce((n, t) => n + t.arms[baseline]!.passed, 0),
        passArm: rows.reduce((n, t) => n + t.arms[arm]!.passed, 0),
      };
    }
    comparisons.push({
      arm,
      baseline,
      tasks: paired.length,
      passBase: paired.reduce((n, t) => n + t.arms[baseline]!.passed, 0),
      passArm: paired.reduce((n, t) => n + t.arms[arm]!.passed, 0),
      runsBase: paired.reduce((n, t) => n + t.arms[baseline]!.runs, 0),
      runsArm: paired.reduce((n, t) => n + t.arms[arm]!.runs, 0),
      timeRatio: geo(ratios(paired, "wallS")),
      tokenRatio: geo(ratios(paired, "tokens")),
      toolRatio: geo(ratios(paired, "toolCalls")),
      faster: paired.filter((t) => t.arms[arm]!.wallS < t.arms[baseline]!.wallS).length,
      slower: paired.filter((t) => t.arms[arm]!.wallS > t.arms[baseline]!.wallS).length,
      cheaper: paired.filter((t) => t.arms[arm]!.tokens < t.arms[baseline]!.tokens).length,
      pricier: paired.filter((t) => t.arms[arm]!.tokens > t.arms[baseline]!.tokens).length,
      byCategory,
    });
  }
  return { exp: spec, generatedAt: new Date().toISOString(), arms, tasks, comparisons, runs };
}

const k = (n: number) => (Number.isFinite(n) ? `${Math.round(n / 1000)}k` : "–");
const s = (n: number) => (Number.isFinite(n) ? `${Math.round(n)}s` : "–");
const pct = (r: number) => (Number.isFinite(r) ? `${r < 1 ? "−" : "+"}${Math.abs(Math.round((r - 1) * 100))}%` : "–");

export function printReport(rep: Report): void {
  const e = rep.exp;
  console.log(`${e.exp}: suite ${e.suite}, agent ${e.agent} (${e.model}), gateway build ${e.gatewayId ?? "?"}, ${e.repeats} repeat(s)\n`);
  console.log("arm        passed      median time  median tokens  median tool calls  gateway calls/run");
  for (const a of rep.arms) {
    console.log(`${a.arm.padEnd(10)} ${`${a.passed}/${a.runs}`.padEnd(11)} ${s(a.wallS).padEnd(12)} ${k(a.tokens).padEnd(14)} ${(Number.isFinite(a.toolCalls) ? String(a.toolCalls) : "–").padEnd(18)} ${a.gatewayCalls.toFixed(1)}${a.errors ? `   (${a.errors} error(s))` : ""}`);
  }
  console.log("\nper task (passed/runs, median time, median tokens):");
  for (const t of rep.tasks) {
    const cols = Object.entries(t.arms).map(([arm, c]) => `${arm}: ${c.passed}/${c.runs} ${s(c.wallS)} ${k(c.tokens)}`);
    console.log(`  ${t.taskId.padEnd(24)} ${t.category.padEnd(14)} ${cols.join("   ")}`);
  }
  for (const c of rep.comparisons) {
    console.log(
      `\n${c.arm} vs ${c.baseline} over ${c.tasks} task(s): passed ${c.passArm}/${c.runsArm} vs ${c.passBase}/${c.runsBase}; ` +
        `time ${pct(c.timeRatio)} (faster on ${c.faster}, slower on ${c.slower}); tokens ${pct(c.tokenRatio)} (fewer on ${c.cheaper}, more on ${c.pricier}); tool calls ${pct(c.toolRatio)}`,
    );
    for (const [cat, b] of Object.entries(c.byCategory)) console.log(`  ${cat}: ${b.tasks} task(s), time ${pct(b.timeRatio)}, tokens ${pct(b.tokenRatio)}, passed ${b.passArm} vs ${b.passBase}`);
  }
}
