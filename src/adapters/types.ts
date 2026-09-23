/**
 * Adapter contract, shared by every harness (where each keeps its history: locations.ts).
 * Adapters parse/normalize only; global index searches.
 * See IMPLEMENTATION_PLAN_V2.md §4 and spec §38.
 */
import type { Harness, Session, Turn } from "../core/models.js";
import type { Action } from "../actions/store.js";

/**
 * Version of what the adapters produce from an UNCHANGED native file. Sync
 * skips files whose mtime and size have not moved, so a parser change never
 * reaches an existing index on its own: bump this and the next sync rebuilds
 * the lexical index. (Vectors are keyed by turn id; turns whose text changed
 * keep their old vector until re-embedded.)
 *
 *   1  original parse
 *   2  Codex: subagents keep their own thread id instead of their parent's;
 *      function_call turns carry their arguments (were `shell("")`) and are
 *      context-only (Turn.searchable = false)
 */
export const PARSE_VERSION = 2;

export interface AdapterCapabilities {
  sessions: true;
  turns: true;
  /** MVP: false — search lives in global Tantivy index */
  search: false;
  /** MVP: false — parent/child topology deferred to Phase 2 */
  topology: false;
}

export interface FileCursor {
  mtimeMs: number;
  offsetBytes: number;
}

export interface ContextAdapter {
  readonly harness: Harness;

  capabilities(): AdapterCapabilities;

  /** Enumerate all sessions visible to this adapter */
  listSessions(): Promise<Session[]>;

  /** All normalized turns for a session, ordered by seq */
  listTurns(sessionId: string): Promise<Turn[]>;

  /** Direct retrieval — bypasses index for freshness (spec §44) */
  getTurn(sessionId: string, turnId: string): Promise<Turn>;

  /** Incremental sync state: sourcePath -> cursor */
  getCursor(): Promise<Record<string, FileCursor>>;

  /**
   * What the session's agent did: files edited, commands run (actions/store.ts).
   * Optional: harnesses whose history records no tool calls leave it out.
   */
  listActions?(sessionId: string): Promise<Action[]>;
}
