/** Repo-root resolution for project-aware search (spec §27-28). Cached per workspace. */
import { execFileSync } from "node:child_process";
import { realpathSync, existsSync } from "node:fs";
import { basename, dirname } from "node:path";
import { homedir } from "node:os";

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

/**
 * The project an agent is calling from: the name of the git repo root around
 * `cwd`, or the directory's own name outside a repo. Null in the home
 * directory, at a filesystem root, or above home, where no single project is
 * meant — a server started there searches everything.
 */
export function callerProject(cwd: string = process.cwd(), home: string = homedir()): string | null {
  const root = (repoRoot(cwd) ?? cwd).replace(/[/\\]+$/, "");
  if (!root || dirname(root) === root) return null;
  const h = home.replace(/[/\\]+$/, "");
  if (root === h || (h + "/").startsWith(root + "/")) return null;
  return basename(root) || null;
}
