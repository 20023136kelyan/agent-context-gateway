/**
 * Claude Code adapter — parses ~/.claude/projects/<slug>/<sessionId>.jsonl
 *
 * Native line types observed: user, assistant, system, attachment,
 * queue-operation, custom-title, ai-title, mode, last-prompt.
 * MVP keeps user/assistant/system only; everything else is skipped
 * (no searchable text or pure metadata).
 */
import { readdir, readFile, stat, open } from "node:fs/promises";
import { join } from "node:path";
import type { Harness, Session, Turn, TurnRole } from "../core/models.js";
import { turnId as makeTurnId } from "../core/id.js";
import { actionsOfCall, type Action } from "../actions/store.js";
import type { ContextAdapter, FileCursor } from "./types.js";
import { truncate, extractFileRefs, claudeContentToText, claudeToolNames, isToolResultContent, TURN_CACHE_SESSIONS, TURN_CACHE_CHARS, turnChars } from "./text.js";
import { LruCache } from "../core/lru.js";
import { repoRoot } from "./repo.js";
import { claudeProjectsDir } from "./locations.js";

const HARNESS: Harness = "claude-code";

function defaultBaseDir(): string {
  return claudeProjectsDir();
}

function machineId(): string {
  return "local";
}

export function agentIdForClaude(): string {
  return `${HARNESS}:local`;
}

interface ClaudeLine {
  type?: string;
  uuid?: string;
  parentUuid?: string | null;
  timestamp?: string;
  sessionId?: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  message?: { role?: string; content?: unknown };
}

export class ClaudeAdapter implements ContextAdapter {
  readonly harness: Harness = HARNESS;
  private baseDir: string;
  /** Session metadata cache: path -> {mtimeMs, size, session}. Peek-once. */
  private sessionCache = new Map<string, { mtimeMs: number; size: number; session: Session }>();
  /** Parsed turns cache: path -> {mtimeMs, size, turns}. Avoids re-parsing multi-MB JSONL on every query. */
  private turnsCache = new LruCache<string, { mtimeMs: number; size: number; turns: Turn[] }>(
    TURN_CACHE_SESSIONS,
    TURN_CACHE_CHARS,
    (e) => turnChars(e.turns),
  );
  /** sessionId -> file, filled by listSessions so lookups skip the slug-dir scan. */
  private pathById = new Map<string, { path: string; slug: string }>();

  constructor(baseDir = defaultBaseDir()) {
    this.baseDir = baseDir;
  }

  capabilities() {
    return { sessions: true as const, turns: true as const, search: false as const, topology: false as const };
  }

  /** Locate session file by scanning slug dirs (MVP: O(n) dirs, fine for local). */
  async findSessionFile(sessionId: string): Promise<{ path: string; slug: string } | null> {
    const known = this.pathById.get(sessionId);
    if (known) {
      try {
        await stat(known.path);
        return known;
      } catch {
        this.pathById.delete(sessionId); // moved or deleted: rescan
      }
    }
    let slugs: string[] = [];
    try {
      slugs = await readdir(this.baseDir);
    } catch {
      return null;
    }
    for (const slug of slugs) {
      const candidate = join(this.baseDir, slug, `${sessionId}.jsonl`);
      try {
        await stat(candidate);
        const found = { path: candidate, slug };
        this.pathById.set(sessionId, found);
        return found;
      } catch {
        // not here
      }
    }
    return null;
  }

  async listSessions(): Promise<Session[]> {
    const sessions: Session[] = [];
    let slugs: string[] = [];
    try {
      slugs = await readdir(this.baseDir);
    } catch {
      return [];
    }
    for (const slug of slugs) {
      const dir = join(this.baseDir, slug);
      let files: string[] = [];
      try {
        files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl"));
      } catch {
        continue;
      }
      for (const file of files) {
        const sessionId = file.replace(/\.jsonl$/, "");
        const path = join(dir, file);
        try {
          const meta = await this.cachedSessionMeta(path, sessionId, slug);
          sessions.push(meta);
          this.pathById.set(sessionId, { path, slug });
        } catch {
          // unreadable file — skip, report via health later
        }
      }
    }
    return sessions;
  }

  private async cachedSessionMeta(path: string, sessionId: string, slug: string): Promise<Session> {
    const st = await stat(path);
    const cached = this.sessionCache.get(path);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached.session;
    const session = await this.peekSessionMeta(path, sessionId, slug, st.birthtime.toISOString());
    this.sessionCache.set(path, { mtimeMs: st.mtimeMs, size: st.size, session });
    return session;
  }

  /** Read first chunk for cwd/branch/timestamps without loading whole file. */
  private async peekSessionMeta(path: string, sessionId: string, slug: string, birthtimeIso?: string): Promise<Session> {
    let startedAt: string;
    try {
      startedAt = birthtimeIso ?? (await stat(path)).birthtime.toISOString();
    } catch {
      startedAt = new Date().toISOString();
    }
    let cwd = slug;
    let gitBranch: string | undefined;
    let head = "";
    try {
      const fh = await open(path, "r");
      try {
        const buf = Buffer.alloc(16_384);
        const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
        head = buf.subarray(0, bytesRead).toString("utf8");
      } finally {
        await fh.close();
      }
    } catch {
      // fall back to stat
    }
    if (head) {
      const lines = head.split("\n").slice(0, 50);
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const o = JSON.parse(line) as ClaudeLine;
          if (o.cwd) cwd = o.cwd;
          if (o.gitBranch) gitBranch = o.gitBranch;
          if (o.timestamp && o.timestamp < startedAt) startedAt = o.timestamp;
          if (o.cwd) break;
        } catch {
          continue;
        }
      }
    }
    const projectId = slug;
    return {
      id: sessionId,
      harness: HARNESS,
      agentId: agentIdForClaude(),
      projectId,
      workspace: cwd,
      repo: repoRoot(cwd),
      gitBranch,
      startedAt,
      sourcePath: path,
    };
  }

  async listTurns(sessionId: string): Promise<Turn[]> {
    const found = await this.findSessionFile(sessionId);
    if (!found) throw new Error(`claude session not found: ${sessionId}`);
    const st = await stat(found.path);
    const cached = this.turnsCache.get(found.path);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
      return cached.turns;
    }
    const raw = await readFile(found.path, "utf8");
    const lines = raw.split("\n");
    const turns: Turn[] = [];
    let offset = 0;
    let seq = 0;
    for (const line of lines) {
      const byteLen = Buffer.byteLength(line, "utf8") + 1;
      if (!line.trim()) {
        offset += byteLen;
        continue;
      }
      let o: ClaudeLine;
      try {
        o = JSON.parse(line) as ClaudeLine;
      } catch {
        offset += byteLen;
        continue;
      }
      const turn = this.lineToTurn(o, sessionId, found.path, offset, seq);
      offset += byteLen;
      if (turn) {
        turns.push(turn);
        seq += 1;
      }
    }
    this.turnsCache.set(found.path, { mtimeMs: st.mtimeMs, size: st.size, turns });
    return turns;
  }

  private lineToTurn(o: ClaudeLine, sessionId: string, path: string, offset: number, seq: number): Turn | null {
    const t = o.type;
    if (t !== "user" && t !== "assistant" && t !== "system") return null;
    // Tool results arrive as `user` lines. They are file contents and command
    // output, not the user speaking, so they get the role that says so — a
    // third of this corpus is these, and reading them as utterances made
    // decision extraction quote source files back as "decisions".
    const toolOutput = t === "user" && isToolResultContent(o.message?.content);
    const role: TurnRole = toolOutput ? "tool" : t === "user" ? "user" : t === "assistant" ? "assistant" : "system";
    const contentRaw = claudeContentToText(o.message?.content);
    const content = truncate(contentRaw.trim());
    if (!content) return null;
    const key = o.uuid ?? String(seq);
    return {
      id: makeTurnId(HARNESS, sessionId, key),
      sessionId,
      harness: HARNESS,
      timestamp: o.timestamp ?? new Date().toISOString(),
      role,
      content,
      raw: { uuid: o.uuid, parentUuid: o.parentUuid },
      toolNames: role === "assistant" ? claudeToolNames(o.message?.content) : undefined,
      fileRefs: extractFileRefs(content),
      seq,
      byteOffset: offset,
    };
  }

  /**
   * Files edited and commands run, from the session's tool_use blocks. Tool
   * calls are not turns here (see Turn.searchable), so each action points at
   * the nearest turn at or before its line: what `get_context` should open.
   */
  async listActions(sessionId: string): Promise<Action[]> {
    const found = await this.findSessionFile(sessionId);
    if (!found) return [];
    const turns = await this.listTurns(sessionId).catch(() => [] as Turn[]);
    if (turns.length === 0) return [];
    let raw: string;
    try {
      raw = await readFile(found.path, "utf8");
    } catch {
      return [];
    }
    const actions: Action[] = [];
    let offset = 0;
    let anchor = 0;
    for (const line of raw.split("\n")) {
      const byteLen = Buffer.byteLength(line, "utf8") + 1;
      while (anchor + 1 < turns.length && (turns[anchor + 1].byteOffset ?? Infinity) <= offset) anchor += 1;
      if (line.includes('"tool_use"')) {
        try {
          const o = JSON.parse(line) as ClaudeLine;
          const content = o.message?.content;
          if (o.type === "assistant" && Array.isArray(content)) {
            const ts = o.timestamp ?? turns[anchor].timestamp;
            for (const b of content as Record<string, unknown>[]) {
              if (b?.type === "tool_use" && typeof b.name === "string") {
                actions.push(...actionsOfCall(b.name, b.input, ts, turns[anchor].id));
              }
            }
          }
        } catch {
          // torn line at the end of a live file
        }
      }
      offset += byteLen;
    }
    return actions;
  }

  async getTurn(sessionId: string, turnId: string): Promise<Turn> {
    const turns = await this.listTurns(sessionId);
    const found = turns.find((t) => t.id === turnId);
    if (!found) throw new Error(`turn not found: ${turnId}`);
    return found;
  }

  async getCursor(): Promise<Record<string, FileCursor>> {
    const cursor: Record<string, FileCursor> = {};
    const sessions = await this.listSessions();
    for (const s of sessions) {
      try {
        const st = await stat(s.sourcePath);
        cursor[s.sourcePath] = { mtimeMs: st.mtimeMs, offsetBytes: st.size };
      } catch {
        continue;
      }
    }
    return cursor;
  }
}
