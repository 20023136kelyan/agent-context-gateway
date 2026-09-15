/**
 * Git Repository Hook Integration (spec §28 & §32).
 * Installs post-commit and post-merge hooks that automatically record commit SHAs,
 * branch names, commit messages, and touched files into the Context Gateway artifact graph.
 */
import { existsSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { turnId as makeTurnId } from "../core/id.js";
import { extractFileRefs } from "../adapters/text.js";
import type { GatewayApp } from "../app.js";

export interface GitCommitEvent {
  repo: string;
  sha: string;
  branch: string;
  message: string;
  files: string[];
  timestamp: string;
}

export function installGitHooks(repoPath: string): { installed: string[]; error?: string } {
  const gitDir = join(repoPath, ".git");
  if (!existsSync(gitDir)) {
    throw new Error(`not_a_git_repo: ${repoPath} (.git not found)`);
  }
  const hooksDir = join(gitDir, "hooks");
  mkdirSync(hooksDir, { recursive: true });

  const scriptContent = `#!/bin/sh
# Context Gateway git hook — records commits and modified files into artifact graph
set -e
SHA=$(git rev-parse HEAD 2>/dev/null || echo "")
BRANCH=$(git branch --show-current 2>/dev/null || echo "")
MSG=$(git log -1 --pretty=%B 2>/dev/null || echo "")
FILES=$(git diff-tree --no-commit-id --name-only -r HEAD 2>/dev/null | tr '\\n' ',' | sed 's/,$//')

if [ -n "$SHA" ]; then
  curl -s -X POST "http://127.0.0.1:3000/hooks/git" \\
    -H "Content-Type: application/json" \\
    -d "{\\"repo\\":\\"$(pwd)\\",\\"sha\\":\\"$SHA\\",\\"branch\\":\\"$BRANCH\\",\\"message\\":\\"$MSG\\",\\"files\\":\\"$FILES\\"}" \\
    >/dev/null 2>&1 || true
fi
`;

  const installed: string[] = [];
  for (const hookName of ["post-commit", "post-merge"]) {
    const hookPath = join(hooksDir, hookName);
    writeFileSync(hookPath, scriptContent, { mode: 0o755 });
    try {
      chmodSync(hookPath, 0o755);
    } catch {
      // ignore
    }
    installed.push(hookPath);
  }

  return { installed };
}

/**
 * Handles incoming git commit events from git hooks, indexing the commit
 * as a turn into Tantivy and linking touched files for BFS graph traversal.
 */
export async function handleGitCommitEvent(
  app: GatewayApp,
  event: GitCommitEvent,
): Promise<{ indexed: boolean; turnId: string }> {
  // Ensure the git adapter has this repo registered
  const gitAdapter = app.adapters.find((a) => a.harness === "git") as import("../adapters/git.js").GitAdapter | undefined;
  if (gitAdapter) {
    gitAdapter.addRepo(event.repo);
    gitAdapter.addBranch(event.repo, event.branch);
  }

  const proj = event.repo.split("/").pop() ?? "repo";
  const sessionId = `git-${proj}-${event.branch || "main"}`;
  const turnId = makeTurnId("git", sessionId, event.sha.slice(0, 12));
  const filesList = Array.isArray(event.files) ? event.files : String(event.files).split(",").filter(Boolean);
  const content = `Commit ${event.sha.slice(0, 8)} on ${event.branch}: ${event.message.trim()}\nFiles: ${filesList.join(", ")}`;

  const turn = {
    id: turnId,
    sessionId,
    harness: "git" as const,
    timestamp: event.timestamp || new Date().toISOString(),
    role: "system" as const,
    content,
    raw: { sha: event.sha, branch: event.branch, repo: event.repo },
    fileRefs: [...new Set([...extractFileRefs(content), ...filesList])],
    seq: 0,
  };

  const enriched = {
    ...turn,
    projectId: proj,
    workspace: event.repo,
    repo: event.repo,
  };

  app.index.indexTurns([enriched], join(event.repo, ".git"));
  return { indexed: true, turnId };
}
