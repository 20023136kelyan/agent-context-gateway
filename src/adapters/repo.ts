/** Repo-root resolution for project-aware search (spec §27-28). Cached per workspace. */
import { execFileSync } from "node:child_process";
import { realpathSync, existsSync } from "node:fs";
import { dirname } from "node:path";

const cache = new Map<string, string | null>();

export function repoRoot(workspace: string): string | null {
  if (!workspace || workspace === "unknown") return null;
  const hit = cache.get(workspace);
  if (hit !== undefined) return hit;
  let root: string | null = null;
  try {
    // realpath first: /var vs /private/var spellings must match git's output.
    // Deleted subdirs resolve via the nearest existing ancestor.
    let dir = workspace;
    try {
      dir = realpathSync(workspace);
    } catch {
      let up = workspace;
      for (let i = 0; i < 32; i++) {
        up = dirname(up);
        if (existsSync(up)) {
          dir = realpathSync(up);
          break;
        }
      }
    }
    root = execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() || null;
  } catch {
    root = null;
  }
  cache.set(workspace, root);
  return root;
}
