/**
 * One run's workspace: a fresh clone at the task's base commit that cannot
 * reach the future. Every ref but `main` (at base) is deleted and the objects
 * only later commits used are pruned, so `git log --all`, `git show <gold>`
 * or a stray tag cannot hand the agent the answer. Dependencies are cloned in.
 */
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ensureDir, sh } from "./util.js";
import { cloneTree } from "./prepare.js";
import type { SuiteSpec, TaskSpec } from "./suite.js";

export function createWorkspace(suite: SuiteSpec, task: TaskSpec, runDir: string, nodeModules: string): string {
  // The clone's folder name is the project the gateway scopes search to.
  const ws = join(ensureDir(join(runDir, "work")), suite.project);
  const git = (...a: string[]) => sh("git", a, { cwd: ws });
  sh("git", ["clone", "--quiet", "--no-local", "--no-checkout", suite.repo, ws]);
  git("checkout", "--quiet", "-B", "main", task.base);
  git("remote", "remove", "origin");
  for (const ref of git("for-each-ref", "--format=%(refname)").split("\n").filter(Boolean)) {
    if (ref !== "refs/heads/main") git("update-ref", "-d", ref);
  }
  git("reflog", "expire", "--expire=now", "--all");
  git("repack", "-a", "-d", "-q");
  git("prune", "--expire=now");
  if (gitHas(ws, task.gold)) {
    throw new Error(`workspace for ${task.id} can still reach ${task.gold}`);
  }
  git("config", "user.name", "Bench Agent");
  git("config", "user.email", "bench@localhost");
  // The bench's own files stay out of the agent's diff.
  appendFileSync(join(ws, ".git", "info", "exclude"), "\nnode_modules\n.agents/\n");
  cloneTree(nodeModules, join(ws, "node_modules"));
  return ws;
}

function gitHas(ws: string, commit: string): boolean {
  try {
    sh("git", ["cat-file", "-e", `${commit}^{commit}`], { cwd: ws });
    return true;
  } catch {
    return false;
  }
}

/** The agent's change: everything it left in the tree, against the base commit. */
export function captureDiff(ws: string, base: string): { patch: string; files: string[]; added: number; removed: number } {
  sh("git", ["add", "-A"], { cwd: ws });
  const patch = sh("git", ["diff", "--cached", base], { cwd: ws });
  const stat = sh("git", ["diff", "--cached", "--numstat", base], { cwd: ws });
  let added = 0;
  let removed = 0;
  const files: string[] = [];
  for (const line of stat.split("\n").filter(Boolean)) {
    const [a, r, f] = line.split("\t");
    added += Number(a) || 0;
    removed += Number(r) || 0;
    if (f) files.push(f);
  }
  return { patch, files, added, removed };
}

/** Put the real change's versions of the hidden tests in place, over whatever the agent wrote there. */
export function installHiddenTests(suite: SuiteSpec, task: TaskSpec, ws: string): void {
  for (const f of task.hiddenTests) {
    const body = sh("git", ["show", `${task.gold}:${f}`], { cwd: suite.repo });
    ensureDir(dirname(join(ws, f)));
    writeFileSync(join(ws, f), body);
  }
}

export const workspaceExists = (ws: string) => existsSync(join(ws, ".git"));
