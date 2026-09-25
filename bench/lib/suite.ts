/**
 * A suite: one repository, the agent history recorded while it was built,
 * and tasks replayed from that history.
 *
 * Each task is a real change: the agent starts from `base` (the commit before
 * it) with `prompt`, and succeeds when the tests the real change added or
 * changed (`hiddenTests`, taken from `gold`) pass. The agent never sees those
 * tests or any commit after `base`. With the gateway, it sees the history only
 * as it stood at `asOf`, the moment the task was asked.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT, expandHome } from "./util.js";

/**
 * How much the earlier history should matter, as judged when the task was written:
 * needs-history: the prompt leaves out something only the history holds (a
 *   measurement, a decision, a symptom seen earlier); without it an agent guesses.
 * history-helps: the code holds everything needed, and the history holds where
 *   to look and why, so it should only save time.
 * control: unrelated to earlier work; the gateway should cost nothing.
 */
export type TaskCategory = "needs-history" | "history-helps" | "control";

export interface TaskSpec {
  id: string;
  title: string;
  category: TaskCategory;
  /** The commit the agent starts from. */
  base: string;
  /** The real change; its versions of `hiddenTests` decide success. */
  gold: string;
  /** When the task was asked (ISO): the gateway is pinned here. */
  asOf: string;
  prompt: string;
  /** Test files, as they are at `gold`, that must pass. */
  hiddenTests: string[];
  /** What the earlier history holds that bears on this task (for the report). */
  historyNote?: string;
  timeoutMin?: number;
}

export interface SuiteSpec {
  name: string;
  /** Repository to clone tasks from (path or URL). */
  repo: string;
  /** Folder name of each clone: the gateway scopes search to the caller's project by it. */
  project: string;
  /** History to snapshot: Claude Code project folders, Codex session folders. */
  history: { claude?: string[]; codex?: string[] };
  /** Test runner (vitest only for now). */
  test: { runner: "vitest" };
  /** Said to the agent in every arm after the preamble: quirks of running this repo's tests here. */
  environmentNote?: string;
  tasks: TaskSpec[];
}

export function loadSuite(name: string): SuiteSpec {
  const path = name.endsWith(".json") ? name : join(REPO_ROOT, "bench", "suites", `${name}.json`);
  const suite = JSON.parse(readFileSync(path, "utf8")) as SuiteSpec;
  suite.repo = expandHome(suite.repo);
  suite.history = {
    claude: (suite.history.claude ?? []).map(expandHome),
    codex: (suite.history.codex ?? []).map(expandHome),
  };
  for (const t of suite.tasks) {
    if (Number.isNaN(Date.parse(t.asOf))) throw new Error(`task ${t.id}: bad asOf "${t.asOf}"`);
    if (!t.hiddenTests?.length) throw new Error(`task ${t.id}: no hiddenTests`);
  }
  return suite;
}

export function pickTasks(suite: SuiteSpec, ids?: string[]): TaskSpec[] {
  if (!ids?.length) return suite.tasks;
  const out = ids.map((id) => suite.tasks.find((t) => t.id === id));
  const missing = ids.filter((_, i) => !out[i]);
  if (missing.length) throw new Error(`unknown task(s): ${missing.join(", ")}`);
  return out as TaskSpec[];
}
