/**
 * Codex adapter — parses ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
 *
 * Observed line types: session_meta, response_item, event_msg,
 * turn_context, world_state, token_usage_record.
 * MVP keeps response_item content only:
 *  - message (user/assistant/developer/system) -> Turn
 *  - function_call / custom_tool_call -> tool Turn (name + input)
 *  - function_call_output / custom_tool_call_output -> tool Turn (output)
 *  - reasoning with non-empty summary -> assistant Turn (summary text)
 *    reasoning with empty summary is encrypted (content=null) -> skip
 * Everything else (event_msg, turn_context, world_state, usage) is skipped.
 */
import { readFile, stat, readdir, open } from "node:fs/promises";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import type { Harness, Session, Turn, TurnRole } from "../core/models.js";
import { turnId as makeTurnId } from "../core/id.js";
import type { ContextAdapter, FileCursor } from "./types.js";
import { truncate, extractFileRefs, codexContentToText } from "./text.js";
import { repoRoot } from "./repo.js";

const HARNESS: Harness = "codex";

function defaultBaseDir(): string {
  return join(homedir(), ".codex", "sessions");
}

export function agentIdForCodex(): string {
  return `${HARNESS}:local`;
}

interface SessionMetaPayload {
  session_id?: string;
  id?: string;
  timestamp?: string;
  cwd?: string;
  originator?: string;
}

interface CodexLine {
  timestamp?: string;
  ordinal?: number;
  type?: string;
  payload?: Record<string, unknown>;
}

async function walkJsonl(dir: string, out: string[]): Promise<void> {
  let entries: string[] = [];
  try {
    entries = await readdir(dir, { withFileTypes: true } as never) as unknown as string[];
  } catch {
    return;
  }
  // readdir withFileTypes overload typing workaround: re-read plain
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const full = join(dir, name);
    try {
      const st = await stat(full);
      if (st.isDirectory()) await walkJsonl(full, out);
      else if (name.endsWith(".jsonl")) out.push(full);
    } catch {
      continue;
    }
  }
}

export class CodexAdapter implements ContextAdapter {
  readonly harness: Harness = HARNESS;
  private baseDir: string;
  private sessionCache = new Map<string, { mtimeMs: number; size: number; session: Session }>();
  private turnsCache = new Map<string, { mtimeMs: number; size: number; turns: Turn[] }>();

  constructor(baseDir = defaultBaseDir()) {
    this.baseDir = baseDir;
  }

  capabilities() {
    return { sessions: true as const, turns: true as const, search: false as const, topology: false as const };
  }

  async listSessionFiles(): Promise<string[]> {
    const out: string[] = [];
    await walkJsonl(this.baseDir, out);
    return out.sort();
  }

  async findSessionFile(sessionId: string): Promise<string | null> {
    const files = await this.listSessionFiles();
    // Fast path: filename contains session id
    for (const f of files) {
      if (basename(f).includes(sessionId)) return f;
    }
    // Slow path: check session_meta
    for (const f of files) {
      try {
        const first = await this.readFirstLine(f);
        const o = JSON.parse(first) as CodexLine;
        const p = (o.payload ?? {}) as SessionMetaPayload;
        if (p.session_id === sessionId || p.id === sessionId) return f;
      } catch {
        continue;
      }
    }
    return null;
  }

  async listSessions(): Promise<Session[]> {
    const files = await this.listSessionFiles();
    const sessions: Session[] = [];
    for (const path of files) {
      try {
        const st = await stat(path);
        const cached = this.sessionCache.get(path);
        if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
          sessions.push(cached.session);
          continue;
        }
        const s = await this.peekSessionMeta(path);
        if (s) {
          this.sessionCache.set(path, { mtimeMs: st.mtimeMs, size: st.size, session: s });
          sessions.push(s);
        }
      } catch {
        continue;
      }
    }
    return sessions;
  }

  /** session_meta is always the first line, but its payload (base_instructions)
   *  can exceed any fixed head-read — stream until the first newline. */
  private async readFirstLine(path: string): Promise<string> {
    const fh = await open(path, "r");
    try {
      const chunks: Buffer[] = [];
      let seen = 0;
      for (;;) {
        const buf = Buffer.alloc(8192);
        const { bytesRead } = await fh.read(buf, 0, buf.length, null);
        if (bytesRead === 0) break;
        chunks.push(buf.subarray(0, bytesRead));
        seen += bytesRead;
        if (buf.subarray(0, bytesRead).includes(0x0a) || seen > 1_048_576) break;
      }
      return Buffer.concat(chunks).toString("utf8").split("\n")[0];
    } finally {
      await fh.close();
    }
  }

  private async peekSessionMeta(path: string): Promise<Session | null> {
    const st = await stat(path);
    let firstLine: string;
    try {
      firstLine = await this.readFirstLine(path);
    } catch {
      return null;
    }
    let sessionId = basename(path).replace(/\.jsonl$/, "");
    let cwd = "";
    let startedAt = st.birthtime.toISOString();
    try {
      const o = JSON.parse(firstLine) as CodexLine;
      if (o.type === "session_meta") {
        const p = (o.payload ?? {}) as SessionMetaPayload;
        sessionId = p.session_id ?? p.id ?? sessionId;
        if (p.cwd) cwd = p.cwd;
        if (p.timestamp) startedAt = p.timestamp;
      }
      if (o.timestamp && o.timestamp < startedAt) startedAt = o.timestamp;
    } catch {
      // keep filename fallback
    }
    if (!sessionId) return null;
    const projectId = cwd ? basename(cwd) : "unknown";
    return {
      id: sessionId,
      harness: HARNESS,
      agentId: agentIdForCodex(),
      projectId,
      workspace: cwd || projectId,
      repo: repoRoot(cwd),
      startedAt,
      sourcePath: path,
    };
  }

  async listTurns(sessionId: string): Promise<Turn[]> {
    const path = await this.findSessionFile(sessionId);
    if (!path) throw new Error(`codex session not found: ${sessionId}`);
    const st = await stat(path);
    const cached = this.turnsCache.get(path);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
      return cached.turns;
    }
    const raw = await readFile(path, "utf8");
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
      let o: CodexLine;
      try {
        o = JSON.parse(line) as CodexLine;
      } catch {
        offset += byteLen;
        continue;
      }
      const turn = this.lineToTurn(o, sessionId, path, o.timestamp ?? new Date().toISOString(), offset, seq);
      offset += byteLen;
      if (turn) {
        turns.push(turn);
        seq += 1;
      }
    }
    this.turnsCache.set(path, { mtimeMs: st.mtimeMs, size: st.size, turns });
    return turns;
  }

  private lineToTurn(
    o: CodexLine,
    sessionId: string,
    path: string,
    timestamp: string,
    offset: number,
    seq: number,
  ): Turn | null {
    if (o.type !== "response_item") return null;
    const p = (o.payload ?? {}) as Record<string, unknown>;
    const ptype = p.type as string | undefined;

    if (ptype === "message") {
      const roleRaw = p.role as string | undefined;
      const role: TurnRole =
        roleRaw === "user" ? "user" : roleRaw === "assistant" ? "assistant" : "system";
      // Skip empty system scaffolding? Keep user + real assistant; skip
      // developer preamble >2k chars of pure instructions on first turns?
      // MVP: keep all, ranker handles it. But skip empty.
      const content = truncate(codexContentToText(p.content).trim());
      if (!content) return null;
      const key = (p.id as string | undefined) ?? String(seq);
      return {
        id: makeTurnId(HARNESS, sessionId, key),
        sessionId,
        harness: HARNESS,
        timestamp,
        role,
        content,
        raw: { id: p.id, role: p.role },
        fileRefs: extractFileRefs(content),
        seq,
        byteOffset: offset,
      };
    }

    if (ptype === "function_call" || ptype === "custom_tool_call") {
      const name = (p.name as string | undefined) ?? ptype;
      const input = typeof p.input === "string" ? p.input : JSON.stringify(p.input ?? "");
      const content = truncate(`${name}(${input})`, 4000);
      if (!content.trim()) return null;
      const key = (p.id as string | undefined) ?? `${ptype}-${seq}`;
      return {
        id: makeTurnId(HARNESS, sessionId, key),
        sessionId,
        harness: HARNESS,
        timestamp,
        role: "tool",
        content,
        raw: { id: p.id, call_id: p.call_id },
        toolNames: [name],
        fileRefs: extractFileRefs(content),
        seq,
        byteOffset: offset,
      };
    }

    if (ptype === "function_call_output" || ptype === "custom_tool_call_output") {
      const output = typeof p.output === "string" ? p.output : JSON.stringify(p.output ?? "");
      const content = truncate(output.trim(), 4000);
      if (!content) return null;
      const key = (p.id as string | undefined) ?? `${ptype}-${seq}`;
      return {
        id: makeTurnId(HARNESS, sessionId, key),
        sessionId,
        harness: HARNESS,
        timestamp,
        role: "tool",
        content,
        raw: { id: p.id, call_id: p.call_id },
        fileRefs: extractFileRefs(content),
        seq,
        byteOffset: offset,
      };
    }

    if (ptype === "reasoning") {
      const summary = p.summary as Array<{ text?: string }> | undefined;
      const text = Array.isArray(summary)
        ? summary.map((s) => s?.text ?? "").filter(Boolean).join("\n").trim()
        : "";
      if (!text) return null; // encrypted / empty — nothing searchable
      const content = truncate(text);
      const key = (p.id as string | undefined) ?? `reasoning-${seq}`;
      return {
        id: makeTurnId(HARNESS, sessionId, key),
        sessionId,
        harness: HARNESS,
        timestamp,
        role: "assistant",
        content,
        raw: { id: p.id },
        fileRefs: extractFileRefs(content),
        seq,
        byteOffset: offset,
      };
    }

    return null;
  }

  async getTurn(sessionId: string, turnId: string): Promise<Turn> {
    const turns = await this.listTurns(sessionId);
    const found = turns.find((t) => t.id === turnId);
    if (!found) throw new Error(`turn not found: ${turnId}`);
    return found;
  }

  async getCursor(): Promise<Record<string, FileCursor>> {
    const cursor: Record<string, FileCursor> = {};
    const files = await this.listSessionFiles();
    for (const f of files) {
      try {
        const st = await stat(f);
        cursor[f] = { mtimeMs: st.mtimeMs, offsetBytes: st.size };
      } catch {
        continue;
      }
    }
    return cursor;
  }
}
