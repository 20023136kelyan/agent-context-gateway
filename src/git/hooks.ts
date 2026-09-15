/**
 * Git Repository Hook Integration (spec §28 & §32).
 * Installs post-commit and post-merge hooks that automatically record commit SHAs,
 * branch names, commit messages, and touched files into the Context Gateway artifact graph.
 */
import { existsSync, mkdirSync, writeFileSync, chmodSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { turnId as makeTurnId } from "../core/id.js";
import { extractFileRefs } from "../adapters/text.js";
import type { GatewayApp } from "../app.js";
import { notifyNewTurns } from "../commands.js";

export interface GitCommitEvent {
  repo: string;
  sha: string;
  branch: string;
  message: string;
  files: string[];
  timestamp: string;
}

/** Marks hooks we manage, so reinstalling never treats our own hook as a user hook. */
const SENTINEL = "# context-gateway-hook";

// Fields go through curl --data-urlencode: any message (newlines, quotes,
// backslashes) arrives intact, unlike JSON assembled by shell interpolation.
// A pre-existing hook is kept as <name>.pre-gateway and runs first.
const HOOK_SCRIPT = `#!/bin/sh
${SENTINEL} (installed by \`gateway git-hooks install\`)
status=0
if [ -x "$0.pre-gateway" ]; then
  "$0.pre-gateway" "$@" || status=$?
fi
sha=$(git rev-parse HEAD 2>/dev/null) || exit $status
branch=$(git branch --show-current 2>/dev/null)
message=$(git log -1 --pretty=%B 2>/dev/null)
stamp=$(git log -1 --pretty=%aI 2>/dev/null)
files=$(git diff-tree --root --no-commit-id --name-only -r HEAD 2>/dev/null)
repo=$(git rev-parse --show-toplevel 2>/dev/null)
if [ -n "$GATEWAY_TOKEN" ]; then set -- -H "Authorization: Bearer $GATEWAY_TOKEN"; else set --; fi
curl -s -o /dev/null -m 5 -X POST "http://127.0.0.1:\${GATEWAY_PORT:-3000}/hooks/git" "$@" \\
  --data-urlencode "repo=$repo" --data-urlencode "sha=$sha" --data-urlencode "branch=$branch" \\
  --data-urlencode "message=$message" --data-urlencode "files=$files" --data-urlencode "timestamp=$stamp" \\
  >/dev/null 2>&1 || true
exit $status
`;

export function installGitHooks(repoPath: string): { installed: string[]; preserved: string[] } {
  const gitDir = join(repoPath, ".git");
  if (!existsSync(gitDir)) {
    throw new Error(`not_a_git_repo: ${repoPath} (.git not found)`);
  }
  const hooksDir = join(gitDir, "hooks");
  mkdirSync(hooksDir, { recursive: true });

  const installed: string[] = [];
  const preserved: string[] = [];
  for (const hookName of ["post-commit", "post-merge"]) {
    const hookPath = join(hooksDir, hookName);
    const backup = `${hookPath}.pre-gateway`;
    if (existsSync(hookPath) && !readFileSync(hookPath, "utf8").includes(SENTINEL)) {
      if (existsSync(backup)) {
        throw new Error(`bad_request: both ${hookPath} and ${backup} exist; merge them by hand, then re-run install`);
      }
      renameSync(hookPath, backup);
      preserved.push(backup);
    }
    writeFileSync(hookPath, HOOK_SCRIPT, { mode: 0o755 });
    try {
      chmodSync(hookPath, 0o755);
    } catch {
      // ignore
    }
    installed.push(hookPath);
  }

  return { installed, preserved };
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

  const fresh = await app.indexLock.run(() => {
    const known = app.index.existingIds([turnId]).has(turnId);
    app.index.indexTurns([enriched], join(event.repo, ".git"));
    return known ? [] : [turn];
  });
  await notifyNewTurns(app, fresh);
  return { indexed: true, turnId };
}
