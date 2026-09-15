/**
 * Adapter contract — MVP (Claude Code + Codex).
 * Adapters parse/normalize only; global index searches.
 * See IMPLEMENTATION_PLAN_V2.md §4 and spec §38.
 */
import type { Harness, Session, Turn } from "../core/models.js";

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
}
