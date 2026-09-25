/**
 * Did the agent's change do the task? The real change's tests decide: they
 * are put in place after the agent stops (installHiddenTests) and run on the
 * agent's tree. A task passes when every test in those files passes.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanEnv, run } from "./util.js";
import type { TaskSpec } from "./suite.js";

export interface CheckResult {
  passed: boolean;
  tests: number;
  failed: number;
  /** Test files that failed to load or run at all (a syntax error, a missing export). */
  brokenFiles: string[];
  failures: { test: string; message: string }[];
  ms: number;
  timedOut: boolean;
}

/** The hidden files that are test files (the rest are fixtures and helpers they need). */
export const testFiles = (task: TaskSpec) => task.hiddenTests.filter((f) => /\.test\.[cm]?[jt]sx?$/.test(f));

/** `wrap` runs the tests under the same sandbox as the agent: they execute the agent's code. */
export async function runHiddenTests(task: TaskSpec, ws: string, outPath: string, wrap: string[] = []): Promise<CheckResult> {
  const files = testFiles(task);
  // The report is written inside the workspace (the sandbox allows it there) and read from there.
  const inside = join(ws, ".bench-tests.json");
  const args = ["vitest", "run", ...files, "--reporter=json", `--outputFile=${inside}`];
  const r = await run(wrap.length ? wrap[0]! : "npx", wrap.length ? [...wrap.slice(1), "npx", ...args] : args, {
    cwd: ws,
    env: cleanEnv({ CI: "1" }),
    timeoutMs: 10 * 60_000,
  });
  const base: CheckResult = { passed: false, tests: 0, failed: 0, brokenFiles: [], failures: [], ms: r.ms, timedOut: r.timedOut };
  if (existsSync(inside)) writeFileSync(outPath, readFileSync(inside));
  if (!existsSync(outPath)) {
    return { ...base, brokenFiles: files, failures: [{ test: "(vitest)", message: (r.stderr || r.stdout).slice(-2000) }] };
  }
  const report = JSON.parse(readFileSync(outPath, "utf8")) as {
    numTotalTests: number;
    numFailedTests: number;
    testResults: { name: string; status: string; message?: string; assertionResults: { fullName: string; status: string; failureMessages: string[] }[] }[];
  };
  const failures: CheckResult["failures"] = [];
  const brokenFiles: string[] = [];
  for (const file of report.testResults) {
    const rel = file.name.startsWith(ws) ? file.name.slice(ws.length + 1) : file.name;
    if (file.status !== "passed" && file.assertionResults.length === 0) {
      brokenFiles.push(rel);
      failures.push({ test: rel, message: (file.message ?? "").slice(0, 2000) });
    }
    for (const a of file.assertionResults) {
      if (a.status === "failed") failures.push({ test: a.fullName, message: a.failureMessages.join("\n").slice(0, 2000) });
    }
  }
  // Every hidden test file must have run: one that never loaded is a failure, not a pass.
  const ran = new Set(report.testResults.map((f) => (f.name.startsWith(ws) ? f.name.slice(ws.length + 1) : f.name)));
  for (const f of files) if (!ran.has(f) && !brokenFiles.includes(f)) brokenFiles.push(f);
  const passed = report.numTotalTests > 0 && report.numFailedTests === 0 && brokenFiles.length === 0 && failures.length === 0 && !r.timedOut;
  return { passed, tests: report.numTotalTests, failed: report.numFailedTests, brokenFiles, failures: failures.slice(0, 50), ms: r.ms, timedOut: r.timedOut };
}

export const checkSummary = (c: CheckResult) =>
  c.passed ? `pass (${c.tests} tests)` : `fail (${c.failed}/${c.tests} failed${c.brokenFiles.length ? `, ${c.brokenFiles.length} file(s) broken` : ""}${c.timedOut ? ", timed out" : ""})`;

