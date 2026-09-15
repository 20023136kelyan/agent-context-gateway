/**
 * Cursor adapter — EXPERIMENTAL, unverified against real history.
 * No Cursor conversations exist on this machine (empty draft only), so this
 * parses the documented 2026 format and degrades to zero sessions otherwise:
 *
 * Global DB: ~/Library/Application Support/Cursor/User/globalStorage/state.vscdb
 *  - ItemTable `composer.composerHeaders` -> {allComposers: [{composerId|id,
 *    name|title, createdAt|timestamp, mode, workspaceIdentifier}]}
 *  - cursorDiskKV `composerData:<id>` -> full composer JSON (fallback headers)
 *  - cursorDiskKV `bubbleId:<composerId>:<bubbleId>` -> message JSON (~60 fields;
 *    role/text field names vary by version -> parsed defensively)
 * Workspace DBs: workspaceStorage/<hash>/{workspace.json, state.vscdb}
 *  - workspace.json {folder: "file:///..."} maps workspaceIdentifier -> project
 *
 * Read-only: only SELECTs, never writes (Cursor may hold the DB open).
 */
import { readdir, stat, readFile } from "node:fs/promises";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import type { Harness, Session, Turn, TurnRole } from "../core/models.js";
import { turnId as makeTurnId } from "../core/id.js";
import type { ContextAdapter, FileCursor } from "./types.js";
import { truncate, extractFileRefs } from "./text.js";
import { repoRoot } from "./repo.js";

const HARNESS: Harness = "cursor";

// Lazy: node:sqlite is experimental (warning noise) and only needed here.
const require = createRequire(import.meta.url);
type DatabaseSyncType = typeof import("node:sqlite")["DatabaseSync"];
function loadDatabaseSync(): DatabaseSyncType {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return (require("node:sqlite") as typeof import("node:sqlite")).DatabaseSync;
}

export function defaultCursorDirs(): { globalDb: string; workspaceRoot: string } {
  const user = join(homedir(), "Library", "Application Support", "Cursor", "User");
  return { globalDb: join(user, "globalStorage", "state.vscdb"), workspaceRoot: join(user, "workspaceStorage") };
}

interface ComposerHeader {
  composerId?: string;
  id?: string;
  name?: string;
  title?: string;
  createdAt?: string | number;
  timestamp?: string | number;
  mode?: string;
  workspaceIdentifier?: string;
}

function tsOf(v: unknown, fallback: string): string {
  if (typeof v === "string" && v) {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? fallback : d.toISOString();
  }
  if (typeof v === "number" && v > 0) {
    const ms = v < 1e12 ? v * 1000 : v;
    return new Date(ms).toISOString();
  }
  return fallback;
}

/** Defensive bubble -> {role, text}: field names vary across Cursor versions. */
export function bubbleToTurn(bubble: unknown): { role: TurnRole; text: string; toolNames: string[] } | null {
  if (!bubble || typeof bubble !== "object") return null;
  const b = bubble as Record<string, unknown>;
  const pick = (...keys: string[]): unknown => {
    for (const k of keys) if (b[k] !== undefined && b[k] !== null) return b[k];
    return undefined;
  };
  const rawRole = String(pick("role", "sender", "author") ?? "").toLowerCase();
  const rawType = String(pick("type", "bubbleType", "kind") ?? "").toLowerCase();
  const role: TurnRole =
    /user|human|prompt/.test(rawRole + " " + rawType) ? "user"
    : /assistant|ai|response|result/.test(rawRole + " " + rawType) ? "assistant"
    : /tool|function|call/.test(rawRole + " " + rawType) ? "tool"
    : "unknown";
  const rawText = pick("text", "content", "message", "body", "markdown");
  let text = "";
  if (typeof rawText === "string") text = rawText;
  else if (Array.isArray(rawText)) {
    text = rawText
      .map((p) => (typeof p === "string" ? p : (p as Record<string, unknown>)?.text ?? (p as Record<string, unknown>)?.content ?? ""))
      .filter((s) => typeof s === "string" && s)
      .join("\n");
  }
  text = text.trim();
  if (!text) return null;
  const toolNames: string[] = [];
  const tools = b.toolCalls ?? b.tools;
  if (Array.isArray(tools)) {
    for (const t of tools) {
      const name = (t as Record<string, unknown>)?.name ?? (t as Record<string, unknown>)?.tool;
      if (typeof name === "string") toolNames.push(name);
    }
  }
  return { role, text, toolNames };
}

export class CursorAdapter implements ContextAdapter {
  readonly harness: Harness = HARNESS;
  private globalDb: string;
  private workspaceRoot: string;
  private wsCache = new Map<string, string>();
  private wsFolder = new Map<string, string>();

  constructor(globalDb?: string, workspaceRoot?: string) {
    const d = defaultCursorDirs();
    this.globalDb = globalDb ?? d.globalDb;
    this.workspaceRoot = workspaceRoot ?? d.workspaceRoot;
  }

  capabilities() {
    return { sessions: true as const, turns: true as const, search: false as const, topology: false as const };
  }

  private openDb(path: string): InstanceType<DatabaseSyncType> | null {
    try {
      return new (loadDatabaseSync())(path);
    } catch {
      return null;
    }
  }

  private readItem(db: InstanceType<DatabaseSyncType>, key: string): string | null {
    try {
      const row = db.prepare("SELECT value FROM ItemTable WHERE key = ?").get(key) as { value: unknown } | undefined;
      if (!row) return null;
      const v = row.value;
      return typeof v === "string" ? v : Buffer.isBuffer(v) ? v.toString("utf8") : String(v ?? "");
    } catch {
      return null;
    }
  }

  private listHeaders(): ComposerHeader[] {
    const db = this.openDb(this.globalDb);
    if (!db) return [];
    try {
      const raw = this.readItem(db, "composer.composerHeaders");
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as { allComposers?: ComposerHeader[]; composers?: ComposerHeader[] };
          const list = parsed.allComposers ?? parsed.composers ?? [];
          if (Array.isArray(list) && list.length) return list;
        } catch {
          // fall through to KV scan
        }
      }
      // Fallback: distinct composer ids from cursorDiskKV keys.
      const ids = new Set<string>();
      try {
        const rows = db.prepare("SELECT DISTINCT key FROM cursorDiskKV WHERE key LIKE 'composerData:%' OR key LIKE 'bubbleId:%'").all() as { key: string }[];
        for (const r of rows) {
          const m = r.key.match(/^(?:composerData|bubbleId):([^:]+)/);
          if (m) ids.add(m[1]);
        }
      } catch {
        // no cursorDiskKV table
      }
      return [...ids].map((id) => ({ composerId: id }));
    } finally {
      try {
        db.close();
      } catch {
        // ignore
      }
    }
  }

  async resolveWorkspace(identifier: string | undefined): Promise<string> {
    if (!identifier) return "unknown";
    const cached = this.wsCache.get(identifier);
    if (cached) return cached;
    try {
      const dirs = await readdir(this.workspaceRoot);
      for (const d of dirs) {
        try {
          const raw = await readFile(join(this.workspaceRoot, d, "workspace.json"), "utf8");
          const folder = (JSON.parse(raw) as { folder?: string }).folder ?? "";
          const decoded = decodeURIComponent(folder.replace(/^file:\/\//, ""));
          if (d === identifier || decoded.includes(identifier) || identifier.includes(d)) {
            const name = basename(decoded) || "unknown";
            this.wsCache.set(identifier, name);
            this.wsFolder.set(identifier, decoded);
            return name;
          }
        } catch {
          continue;
        }
      }
    } catch {
      // no workspace root
    }
    this.wsCache.set(identifier, "unknown");
    return "unknown";
  }

  async listSessions(): Promise<Session[]> {
    const headers = this.listHeaders();
    const out: Session[] = [];
    let mtime = "";
    try {
      mtime = (await stat(this.globalDb)).birthtime.toISOString();
    } catch {
      // global db missing -> no sessions
    }
    for (const h of headers) {
      const id = h.composerId ?? h.id;
      if (!id) continue;
      const projectId = await this.resolveWorkspace(h.workspaceIdentifier);
      const folder = h.workspaceIdentifier ? this.wsFolder.get(h.workspaceIdentifier) : undefined;
      out.push({
        id,
        harness: HARNESS,
        agentId: `${HARNESS}:local`,
        projectId,
        workspace: folder ?? projectId,
        repo: folder ? repoRoot(folder) : null,
        startedAt: tsOf(h.createdAt ?? h.timestamp, mtime || new Date().toISOString()),
        sourcePath: this.globalDb,
      });
    }
    return out;
  }

  async listTurns(sessionId: string): Promise<Turn[]> {
    const db = this.openDb(this.globalDb);
    if (!db) throw new Error(`cursor session not found: ${sessionId}`);
    try {
      let rows: { key: string; value: unknown }[] = [];
      try {
        rows = db.prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE ? ORDER BY rowid").all(`bubbleId:${sessionId}:%`) as typeof rows;
      } catch {
        rows = [];
      }
      // Legacy: bubbles embedded in composerData conversationMap.
      if (rows.length === 0) {
        try {
          const raw = db.prepare("SELECT value FROM cursorDiskKV WHERE key = ?").get(`composerData:${sessionId}`) as { value: unknown } | undefined;
          const text = raw && (typeof raw.value === "string" ? raw.value : Buffer.isBuffer(raw.value) ? raw.value.toString("utf8") : "");
          if (text) {
            const parsed = JSON.parse(text) as { conversationMap?: Record<string, unknown> };
            const map = parsed.conversationMap ?? {};
            rows = Object.entries(map).map(([k, value]) => ({ key: k, value: JSON.stringify(value) }));
          }
        } catch {
          // no legacy map
        }
      }
      const sessions = await this.listSessions().catch(() => []);
      const meta = sessions.find((s) => s.id === sessionId);
      const turns: Turn[] = [];
      let seq = 0;
      for (const r of rows) {
        let bubble: unknown;
        try {
          const s = typeof r.value === "string" ? r.value : Buffer.isBuffer(r.value) ? r.value.toString("utf8") : "";
          bubble = JSON.parse(s);
        } catch {
          continue;
        }
        const parsed = bubbleToTurn(bubble);
        if (!parsed) continue;
        const content = truncate(parsed.text.trim());
        if (!content) continue;
        const b = bubble as Record<string, unknown>;
        const key = String(b.bubbleId ?? b.id ?? `${sessionId}:${seq}`);
        turns.push({
          id: makeTurnId(HARNESS, sessionId, key),
          sessionId,
          harness: HARNESS,
          timestamp: tsOf(b.timestamp ?? b.createdAt, meta?.startedAt ?? new Date().toISOString()),
          role: parsed.role,
          content,
          raw: {},
          toolNames: parsed.toolNames.length ? parsed.toolNames : undefined,
          fileRefs: extractFileRefs(content),
          seq: seq++,
        });
      }
      return turns;
    } finally {
      try {
        db.close();
      } catch {
        // ignore
      }
    }
  }

  async getTurn(sessionId: string, turnId: string): Promise<Turn> {
    const turns = await this.listTurns(sessionId);
    const found = turns.find((t) => t.id === turnId);
    if (!found) throw new Error(`turn not found: ${turnId}`);
    return found;
  }

  async getCursor(): Promise<Record<string, FileCursor>> {
    try {
      const st = await stat(this.globalDb);
      return { [this.globalDb]: { mtimeMs: st.mtimeMs, offsetBytes: st.size } };
    } catch {
      return {};
    }
  }
}
