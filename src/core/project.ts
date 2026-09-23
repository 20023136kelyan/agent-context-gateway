/**
 * Project identity across harnesses.
 *
 * Every adapter names projects its own way: Claude Code uses its directory
 * slug ("-Users-alice-dev-app"), Codex the working directory's basename
 * ("app"), OpenCode its project table, trajectories the repo name. A `project`
 * filter that compared projectId exactly could therefore never match the same
 * repo across two harnesses, and the same repo checked out as "Cozea 2.0" on
 * one machine and "cozea-2.0" on another was two projects.
 *
 * So a project is matched by KEY: the folder name of the session's repo root
 * or working directory, lowercased with punctuation dropped. Exact projectId
 * still matches too, so existing filters keep working. Keys are computed from
 * the session at query time, which needs no reindex: nothing stored changes.
 */
import { basename } from "node:path";
import type { Session } from "./models.js";

/** "Cozea 2.0", "cozea-2.0" and "COZEA_2_0" are one project: "cozea20". */
export function projectKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** Every key a session answers to: its repo root's name, its workspace's, its projectId. */
export function sessionProjectKeys(s: Pick<Session, "projectId" | "workspace" | "repo">): Set<string> {
  const keys = new Set<string>();
  for (const path of [s.repo, s.workspace]) {
    const name = path ? basename(path.replace(/[/\\]+$/, "")) : "";
    const key = projectKey(name);
    if (key) keys.add(key);
  }
  const own = projectKey(s.projectId ?? "");
  if (own) keys.add(own);
  return keys;
}

/** Does `session` belong to `project` (an exact projectId, or any name its key matches)? */
export function inProject(session: Pick<Session, "projectId" | "workspace" | "repo">, project: string): boolean {
  if (session.projectId === project) return true;
  const key = projectKey(project);
  return key !== "" && sessionProjectKeys(session).has(key);
}
