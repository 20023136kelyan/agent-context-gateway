/**
 * Action index: what agents DID, as exact facts.
 *
 * Search ranks what agents SAID. "Has another agent already edited
 * client.ts?" or "who ran the migration?" are not ranking questions: they
 * have exact answers in the tool calls. Ranked alongside discussion those
 * calls hurt (0.03-0.06 NDCG@5 on real history, see Turn.searchable), so they
 * live here instead, as rows: session, time, kind, target, and the turn to
 * open for context. No model is involved in answering.
 *
 * Derived state like the search index: rebuilt from native histories, safe
 * to delete. Rows for a session are replaced whenever sync re-reads it.
 */
import { createRequire } from "node:module";
import { dirname, isAbsolute, join } from "node:path";
import { mkdirSync } from "node:fs";
import type { Harness } from "../core/models.js";

export type ActionKind = "edit" | "command";

/** One thing an agent did, as an adapter reads it from the native file. */
export interface Action {
  kind: ActionKind;
  /** File path (edit) or command line (command), as the agent wrote it. */
  target: string;
  ts: string;
  /** The turn to open for context (the call itself, or the turn it follows). */
  turnId: string;
}

export interface StoredAction extends Action {
  harness: Harness;
  sessionId: string;
  /** Edit targets relative to the session's workspace, when inside it. */
  rel: string;
}

export interface ActionQuery {
  /** A path or its tail: "client.ts" matches "src/api/client.ts". */
  file?: string;
  /** Substring of the command line: "db:migrate", "git pull". */
  command?: string;
  /** Restrict to these sessions (project scoping resolves to ids). */
  sessionIds?: string[];
  /** ISO timestamp: only actions at or after it. */
  since?: string;
  limit?: number;
}

// node:sqlite is experimental and Vitest's transform strips static `node:`
// imports: load it lazily, as the other SQLite stores do.
const require = createRequire(import.meta.url);
type DatabaseSyncType = typeof import("node:sqlite")["DatabaseSync"];
function loadDatabaseSync(): DatabaseSyncType {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return (require("node:sqlite") as typeof import("node:sqlite")).DatabaseSync;
}

export function defaultActionsPath(stateDir: string): string {
  return join(stateDir, "actions.sqlite");
}

/** Relative to the workspace when the path lies inside it; otherwise as written. */
export function relativeTarget(target: string, workspace: string | undefined): string {
  const t = target.trim().replace(/^\.\//, "");
  if (workspace && isAbsolute(t)) {
    const ws = workspace.replace(/[/\\]+$/, "");
    if (t.startsWith(ws + "/")) return t.slice(ws.length + 1);
  }
  return t;
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** One timestamp format, so `since` and ordering compare correctly across harnesses. */
const iso = (ts: string) => {
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : ts;
};

/** Tool names that change a file, and the input field naming it (Claude Code). */
const EDIT_TOOLS: Record<string, string> = { Edit: "file_path", MultiEdit: "file_path", Write: "file_path", NotebookEdit: "notebook_path" };
/** Tool names whose input IS a command line. */
const COMMAND_TOOLS = new Set(["Bash", "shell", "exec_command", "local_shell", "container.exec"]);
/**
 * Codex Desktop code-mode tools: the input is a script that calls other
 * tools. Real histories (3.6k `exec` calls in one corpus) run commands as
 * `tools.exec_command({"cmd":"git pull"})` and apply patches written as string
 * literals with escaped newlines.
 */
const SCRIPT_TOOLS = new Set(["exec", "js"]);
const COMMAND_IN_SCRIPT = /exec_command\(\s*\{\s*"?(?:cmd|command)"?\s*:\s*"((?:[^"\\]|\\.)*)"/g;
/** apply_patch headers: every file a patch touches. */
const PATCH_FILE = /\*\*\* (?:Update|Add|Delete) File: ([^\n]+)|\*\*\* Move to: ([^\n]+)/g;

/** A JSON/JS string body ("git pull \"origin\"") decoded; as written if it is not one. */
function decodeString(body: string): string {
  try {
    return JSON.parse(`"${body}"`) as string;
  } catch {
    return body;
  }
}

/** A patch quoted inside a script has escaped newlines; headers need real ones. */
function unescapeLiteral(text: string): string {
  return text.includes("\\n") ? text.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\"/g, '"') : text;
}

/**
 * The actions in one tool call, whichever harness made it. `input` is the
 * call's arguments: an object (Claude tool_use), or a string (a Codex patch,
 * a command line joined from its argv, or a code-mode script).
 */
export function actionsOfCall(name: string, input: unknown, ts: string, turnId: string): Action[] {
  const field = EDIT_TOOLS[name];
  if (field && input && typeof input === "object") {
    const path = (input as Record<string, unknown>)[field];
    return typeof path === "string" && path.trim() ? [{ kind: "edit", target: path.trim(), ts, turnId }] : [];
  }
  if (input && typeof input === "object") {
    const command = (input as Record<string, unknown>).command ?? (input as Record<string, unknown>).cmd;
    const line = Array.isArray(command) ? command.map(String).join(" ") : typeof command === "string" ? command : "";
    return COMMAND_TOOLS.has(name) && line.trim() ? [{ kind: "command", target: line.trim().slice(0, 2000), ts, turnId }] : [];
  }
  const text = typeof input === "string" ? input : "";
  const out: Action[] = [];
  if (SCRIPT_TOOLS.has(name)) {
    for (const m of text.matchAll(COMMAND_IN_SCRIPT)) {
      const line = decodeString(m[1]).trim();
      if (line) out.push({ kind: "command", target: line.slice(0, 2000), ts, turnId });
    }
  }
  if (text.includes("*** ")) {
    for (const m of unescapeLiteral(text).matchAll(PATCH_FILE)) {
      const f = (m[1] ?? m[2] ?? "").replace(/["'\\]+$/, "").trim();
      if (f) out.push({ kind: "edit", target: f, ts, turnId });
    }
  }
  if (out.length === 0 && COMMAND_TOOLS.has(name) && text.trim()) {
    out.push({ kind: "command", target: text.trim().slice(0, 2000), ts, turnId });
  }
  return out;
}

export class ActionStore {
  private handle: InstanceType<DatabaseSyncType> | null = null;

  /** Opened on first use: every app builds a store, few processes query it. */
  constructor(private path: string) {}

  private get db(): InstanceType<DatabaseSyncType> {
    if (this.handle) return this.handle;
    mkdirSync(dirname(this.path), { recursive: true });
    const DatabaseSync = loadDatabaseSync();
    const db = new DatabaseSync(this.path);
    this.handle = db;
    // MCP servers and a background serve may both write; wait rather than fail.
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec(`CREATE TABLE IF NOT EXISTS actions (
      harness TEXT NOT NULL,
      session_id TEXT NOT NULL,
      ts TEXT NOT NULL,
      kind TEXT NOT NULL,
      target TEXT NOT NULL,
      rel TEXT NOT NULL,
      turn_id TEXT NOT NULL
    )`);
    db.exec("CREATE INDEX IF NOT EXISTS idx_actions_session ON actions(harness, session_id)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_actions_kind_ts ON actions(kind, ts)");
    return db;
  }

  /** Replace everything recorded for one session with what it holds now. */
  replaceSession(harness: Harness, sessionId: string, workspace: string | undefined, actions: Action[]): void {
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM actions WHERE harness = ? AND session_id = ?").run(harness, sessionId);
      const insert = this.db.prepare(
        "INSERT INTO actions (harness, session_id, ts, kind, target, rel, turn_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
      );
      for (const a of actions) {
        const rel = a.kind === "edit" ? relativeTarget(a.target, workspace) : a.target;
        insert.run(harness, sessionId, iso(a.ts), a.kind, a.target, rel, a.turnId);
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  clear(): void {
    this.db.exec("DELETE FROM actions");
  }

  count(): number {
    return Number((this.db.prepare("SELECT count(*) AS n FROM actions").get() as { n: number }).n);
  }

  /**
   * Newest first. `file` and `command` are alternatives (an action matches
   * either); session and time filters apply to both. A file matches by path
   * tail on a `/` boundary: "client.ts" finds "src/api/client.ts", never
   * "src/api/apiclient.ts".
   */
  find(q: ActionQuery): StoredAction[] {
    const either: { sql: string; args: string[] }[] = [];
    if (q.file) {
      const f = q.file.trim().replace(/^\.\//, "");
      const tail = `%/${escapeLike(f)}`;
      either.push({
        sql: "kind = 'edit' AND (rel = ? OR target = ? OR rel LIKE ? ESCAPE '\\' OR target LIKE ? ESCAPE '\\')",
        args: [f, f, tail, tail],
      });
    }
    if (q.command) {
      either.push({ sql: "kind = 'command' AND target LIKE ? ESCAPE '\\'", args: [`%${escapeLike(q.command.trim())}%`] });
    }
    const all: { sql: string; args: string[] }[] = [];
    if (either.length) all.push({ sql: either.map((c) => `(${c.sql})`).join(" OR "), args: either.flatMap((c) => c.args) });
    if (q.sessionIds) {
      if (q.sessionIds.length === 0) return [];
      all.push({ sql: `session_id IN (${q.sessionIds.map(() => "?").join(",")})`, args: q.sessionIds });
    }
    if (q.since) all.push({ sql: "ts >= ?", args: [iso(q.since)] });
    const where = all.length ? `WHERE ${all.map((c) => `(${c.sql})`).join(" AND ")}` : "";
    const limit = Math.max(1, Math.min(q.limit ?? 200, 2000));
    const rows = this.db
      .prepare(`SELECT harness, session_id, ts, kind, target, rel, turn_id FROM actions ${where} ORDER BY ts DESC LIMIT ?`)
      .all(...all.flatMap((c) => c.args), limit) as {
      harness: Harness; session_id: string; ts: string; kind: ActionKind; target: string; rel: string; turn_id: string;
    }[];
    return rows.map((r) => ({
      harness: r.harness, sessionId: r.session_id, ts: r.ts, kind: r.kind, target: r.target, rel: r.rel, turnId: r.turn_id,
    }));
  }

  close(): void {
    try {
      this.handle?.close();
    } catch {
      // best-effort
    }
    this.handle = null;
  }
}
