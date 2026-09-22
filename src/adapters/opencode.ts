/**
 * OpenCode harness adapter (read-only).
 *
 * Source of truth stays where opencode keeps it: the SQLite session store
 * (~/.local/share/opencode/opencode.db). Sessions come from `session`
 * (project name via `project`, working dir inline); turns come from
 * `message` (role + clock) joined to `part` (text payloads). Non-text parts
 * (step markers, reasoning blobs, tool metadata) never become turns.
 *
 * Like every adapter: file errors yield empty results, never throws, so a
 * locked or absent database degrades to "no sessions" instead of an outage.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import type { Harness, Session, Turn, TurnRole } from "../core/models.js";
import { turnId as makeTurnId } from "../core/id.js";
import type { ContextAdapter } from "./types.js";

const HARNESS: Harness = "opencode";

// Lazy: node:sqlite is experimental (warning noise) and only needed here.
// createRequire (not bare require, which does not exist under tsx ESM).
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
type DatabaseSyncType = typeof import("node:sqlite")["DatabaseSync"];
function loadDatabaseSync(): DatabaseSyncType {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return (require("node:sqlite") as typeof import("node:sqlite")).DatabaseSync;
}

function defaultDbPath(): string {
  if (process.env.GATEWAY_OPENCODE_DB) return process.env.GATEWAY_OPENCODE_DB;
  // Tests must never read the developer's real session store: an opencode.db
  // on the test machine would leak live sessions (which quote whatever the
  // developer last ran, including golden queries) into every assertion about
  // counts and rankings. Point at nothing; explicit paths still work.
  if (process.env.VITEST) return join("no-such-dir", "no-opencode.db");
  const dataHome = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  return join(dataHome, "opencode", "opencode.db");
}

const msToIso = (ms: unknown, fallback: string): string => {
  const n = typeof ms === "number" ? ms : Number(ms);
  if (Number.isFinite(n) && n > 0) {
    try {
      return new Date(n).toISOString();
    } catch {
      return fallback;
    }
  }
  return fallback;
};

export class OpenCodeAdapter implements ContextAdapter {
  readonly harness: Harness = HARNESS;
  private dbPath: string;

  constructor(dbPath?: string) {
    this.dbPath = dbPath ?? defaultDbPath();
  }

  capabilities() {
    return { sessions: true as const, turns: true as const, search: false as const, topology: false as const };
  }

  private openDb(): InstanceType<DatabaseSyncType> | null {
    try {
      return new (loadDatabaseSync())(this.dbPath, { readOnly: true });
    } catch {
      return null;
    }
  }

  async listSessions(): Promise<Session[]> {
    const db = this.openDb();
    if (!db) return [];
    try {
      // Sessions + projects only: joining message (millions of rows, no
      // session index on large stores) times out. startedAt falls back to
      // the database mtime — coarse but harmless: asOf and recency filter
      // on turn timestamps from listTurns, never on this field.
      let mtime = new Date(0).toISOString();
      try {
        const { statSync } = await import("node:fs");
        mtime = statSync(this.dbPath).mtime.toISOString();
      } catch {
        // keep epoch fallback
      }
      const rows = db
        .prepare(
          `SELECT s.id AS id, s.directory AS directory,
                  COALESCE(p.name, '') AS project
           FROM session s
           LEFT JOIN project p ON p.id = s.project_id`,
        )
        .all() as { id: string; directory: string | null; project: string }[];
      return rows
        .filter((r) => typeof r.id === "string" && r.id.length > 0)
        .map((r) => {
          const projectId = r.project || (r.directory ? r.directory.split("/").pop() || "unknown" : "unknown");
          return {
            id: r.id,
            harness: HARNESS,
            agentId: `${HARNESS}:local`,
            projectId,
            workspace: r.directory ?? projectId,
            repo: null,
            startedAt: mtime,
            sourcePath: this.dbPath,
          };
        });
    } catch {
      return [];
    } finally {
      try {
        db.close();
      } catch {
        // ignore
      }
    }
  }

  async listTurns(sessionId: string): Promise<Turn[]> {
    const db = this.openDb();
    if (!db) return [];
    try {
      const msgs = db
        .prepare(
          `SELECT m.id AS id, m.time_created AS ts, m.data AS data
           FROM message m WHERE m.session_id = ? ORDER BY m.time_created ASC, m.id ASC`,
        )
        .all(sessionId) as { id: string; ts: number | null; data: string | null }[];
      const parts = db
        .prepare(
          `SELECT p.message_id AS mid, p.data AS data
           FROM part p WHERE p.session_id = ? ORDER BY p.time_created ASC, p.id ASC`,
        )
        .all(sessionId) as { mid: string; data: string | null }[];
      const byMsg = new Map<string, string[]>();
      for (const p of parts) {
        let text = "";
        try {
          const d = JSON.parse(p.data ?? "") as { type?: string; text?: string };
          if (d?.type === "text" && typeof d.text === "string" && d.text.trim().length > 0) {
            text = d.text;
          }
        } catch {
          continue;
        }
        if (text) {
          const list = byMsg.get(p.mid) ?? [];
          list.push(text);
          byMsg.set(p.mid, list);
        }
      }
      const turns: Turn[] = [];
      let seq = 0;
      for (const m of msgs) {
        let role: TurnRole | null = null;
        try {
          const d = JSON.parse(m.data ?? "") as { role?: string };
          if (d?.role === "user") role = "user";
          else if (d?.role === "assistant") role = "assistant";
        } catch {
          continue;
        }
        if (!role) continue;
        const content = (byMsg.get(m.id) ?? []).join("\n\n").trim();
        if (!content) continue;
        turns.push({
          id: makeTurnId(HARNESS, sessionId, m.id),
          sessionId,
          harness: HARNESS,
          timestamp: msToIso(m.ts, new Date(0).toISOString()),
          role,
          content,
          raw: {},
          fileRefs: [],
          seq: seq++,
        });
      }
      return turns;
    } catch {
      return [];
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
    if (!found) throw new Error(`not_found: turn "${turnId}"`);
    return found;
  }

  async getCursor(): Promise<Record<string, import("./types.js").FileCursor>> {
    try {
      const { statSync } = await import("node:fs");
      const st = statSync(this.dbPath);
      return { [this.dbPath]: { mtimeMs: st.mtimeMs, offsetBytes: st.size } };
    } catch {
      return {};
    }
  }
}
