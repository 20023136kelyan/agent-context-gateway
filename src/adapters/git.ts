/**
 * Git Repository Adapter (spec §28 & §32).
 * Treats native Git repository commit logs as an authoritative Context Source.
 * Each branch maps to a Session; each commit maps to a Turn with files & SHAs.
 */
import { existsSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { execFileSync } from "node:child_process";
import type { Harness, Session, Turn } from "../core/models.js";
import { turnId as makeTurnId } from "../core/id.js";
import type { ContextAdapter, FileCursor } from "./types.js";
import { extractFileRefs } from "./text.js";

const HARNESS: Harness = "git";

export class GitAdapter implements ContextAdapter {
  readonly harness: Harness = HARNESS;
  private repos: string[] = [];
  private sessionBranches = new Map<string, Set<string>>();

  constructor(repoPaths: string[] = []) {
    this.repos = repoPaths.filter((p) => existsSync(join(p, ".git")));
  }

  capabilities() {
    return {
      sessions: true as const,
      turns: true as const,
      search: false as const,
      topology: false as const,
    };
  }

  addRepo(repoPath: string): void {
    if (existsSync(join(repoPath, ".git")) && !this.repos.includes(repoPath)) {
      this.repos.push(repoPath);
    }
  }

  addBranch(repoPath: string, branch: string): void {
    const list = this.sessionBranches.get(repoPath) ?? new Set<string>();
    list.add(branch);
    this.sessionBranches.set(repoPath, list);
  }

  async listSessions(): Promise<Session[]> {
    const sessions: Session[] = [];
    for (const repo of this.repos) {
      try {
        const currentBranch = execFileSync("git", ["-C", repo, "branch", "--show-current"], {
          encoding: "utf8",
          timeout: 2000,
          stdio: ["ignore", "pipe", "ignore"],
        }).trim() || "main";

        const headSha = execFileSync("git", ["-C", repo, "rev-parse", "--short", "HEAD"], {
          encoding: "utf8",
          timeout: 2000,
          stdio: ["ignore", "pipe", "ignore"],
        }).trim() || "init";

        const gitHead = join(repo, ".git", "HEAD");
        const startedAt = existsSync(gitHead)
          ? statSync(gitHead).mtime.toISOString()
          : new Date().toISOString();

        const proj = basename(repo);
        const branches = new Set<string>([currentBranch]);
        const custom = this.sessionBranches.get(repo);
        if (custom) for (const b of custom) branches.add(b);

        for (const br of branches) {
          sessions.push({
            id: `git-${proj}-${br}`,
            harness: HARNESS,
            agentId: `${HARNESS}:${headSha}`,
            projectId: proj,
            workspace: repo,
            repo,
            gitBranch: br,
            startedAt,
            sourcePath: join(repo, ".git"),
          });
        }
      } catch {
        continue;
      }
    }
    return sessions;
  }

  async listTurns(sessionId: string): Promise<Turn[]> {
    const sessions = await this.listSessions();
    const session = sessions.find((s) => s.id === sessionId);
    if (!session || !session.repo) {
      throw new Error(`git session not found: ${sessionId}`);
    }

    const turns: Turn[] = [];
    try {
      // Git log format: hash%x00authorDate%x00subject%x00body
      const raw = execFileSync(
        "git",
        ["-C", session.repo, "log", "-n", "50", "--pretty=format:COMMIT_START%n%H%x00%aI%x00%s%n%b", "--name-only"],
        { encoding: "utf8", timeout: 4000, stdio: ["ignore", "pipe", "ignore"] },
      );

      const commits = raw.split("COMMIT_START\n").filter(Boolean);
      let seq = 0;
      for (const c of commits) {
        const lines = c.split("\n");
        if (lines.length === 0) continue;
        const [meta, ...bodyAndFiles] = lines;
        const [sha, ts, subject] = meta.split("\0");
        if (!sha) continue;

        const bodyLines: string[] = [];
        const files: string[] = [];
        let readingFiles = false;
        for (const l of bodyAndFiles) {
          if (!readingFiles && l.includes("/") && !l.includes(" ")) {
            readingFiles = true;
          }
          if (readingFiles) {
            if (l.trim()) files.push(l.trim());
          } else {
            bodyLines.push(l);
          }
        }

        const msg = [subject, ...bodyLines].filter(Boolean).join("\n").trim();
        const content = `Commit ${sha.slice(0, 8)} on ${session.gitBranch}:\n${msg}\n${files.length ? "Files: " + files.join(", ") : ""}`;

        turns.push({
          id: makeTurnId(HARNESS, sessionId, sha.slice(0, 12)),
          sessionId,
          harness: HARNESS,
          timestamp: ts || new Date().toISOString(),
          role: "system",
          content,
          raw: { sha, branch: session.gitBranch, files },
          fileRefs: [...new Set([...extractFileRefs(content), ...files])],
          seq: seq++,
        });
      }
    } catch {
      // empty turns on git failure
    }
    return turns;
  }

  async getTurn(sessionId: string, turnId: string): Promise<Turn> {
    const turns = await this.listTurns(sessionId);
    const hit = turns.find((t) => t.id === turnId);
    if (!hit) throw new Error(`git turn not found: ${turnId}`);
    return hit;
  }

  async getCursor(): Promise<Record<string, FileCursor>> {
    const cursors: Record<string, FileCursor> = {};
    for (const repo of this.repos) {
      const gitHead = join(repo, ".git", "HEAD");
      if (existsSync(gitHead)) {
        const st = statSync(gitHead);
        cursors[gitHead] = { mtimeMs: st.mtimeMs, offsetBytes: st.size };
      }
    }
    return cursors;
  }
}
