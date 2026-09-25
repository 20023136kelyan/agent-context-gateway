/**
 * A task is only a task if its hidden tests fail before the real change and
 * pass after it. `validate` checks both on fresh workspaces (the second one
 * gets the real change's source applied), so a task that passes at base
 * (nothing to do) or fails at gold (the tests need something the clone lacks)
 * is caught before any agent runs on it.
 */
import { rmSync } from "node:fs";
import { join } from "node:path";
import { runHiddenTests, type CheckResult } from "./check.js";
import { prepareDeps } from "./prepare.js";
import { writeSandboxProfile } from "./sandbox.js";
import type { SuiteSpec, TaskSpec } from "./suite.js";
import { BENCH_HOME, ensureDir, sh } from "./util.js";
import { createWorkspace, installHiddenTests } from "./workspace.js";

export interface Validation {
  taskId: string;
  base: CheckResult;
  gold: CheckResult;
  ok: boolean;
  goldFiles: string[];
}

export async function validateTask(suite: SuiteSpec, task: TaskSpec): Promise<Validation> {
  const dir = join(BENCH_HOME, "validate", task.id);
  rmSync(dir, { recursive: true, force: true });
  const deps = prepareDeps(suite.repo, task.base);
  // Before: the base tree with the hidden tests.
  const baseDir = ensureDir(join(dir, "base"));
  const ws1 = createWorkspace(suite, task, baseDir, deps);
  installHiddenTests(suite, task, ws1);
  const base = await runHiddenTests(task, ws1, join(dir, "base-tests.json"), ["sandbox-exec", "-f", writeSandboxProfile(join(baseDir, "sandbox.sb"), join(baseDir, "work"))]);
  // After: the base tree with the real change applied.
  const goldDir = ensureDir(join(dir, "gold"));
  const ws2 = createWorkspace(suite, task, goldDir, deps);
  const patch = sh("git", ["diff", "--binary", task.base, task.gold], { cwd: suite.repo });
  sh("git", ["apply", "--whitespace=nowarn", "-"], { cwd: ws2, input: patch });
  installHiddenTests(suite, task, ws2);
  const gold = await runHiddenTests(task, ws2, join(dir, "gold-tests.json"), ["sandbox-exec", "-f", writeSandboxProfile(join(goldDir, "sandbox.sb"), join(goldDir, "work"))]);
  const goldFiles = sh("git", ["diff", "--name-only", task.base, task.gold], { cwd: suite.repo }).split("\n").filter(Boolean);
  rmSync(join(baseDir, "work"), { recursive: true, force: true });
  rmSync(join(goldDir, "work"), { recursive: true, force: true });
  return { taskId: task.id, base, gold, ok: !base.passed && gold.passed, goldFiles };
}
