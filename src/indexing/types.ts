/**
 * Index abstractions — backend-agnostic so Tantivy can replace SQLite FTS5
 * later without touching adapters/search/transports.
 * (Tantivy npm 0.1.0 spike 2026-09-15: missing darwin-arm64 native binary,
 *  fell back to SQLite FTS5 per IMPLEMENTATION_PLAN_V2 §5 mitigation.)
 */
import type { Turn } from "../core/models.js";

export interface IndexStats {
  docCount: number;
  lastSync?: string;
  perHarness: Record<string, number>;
}

export interface IndexSearchHit {
  turnId: string;
  /** Higher is better (Tantivy BM25 natively; SQLite returns -bm25()). */
  score: number;
}

export interface IndexFilter {
  harness?: string;
  projectId?: string;
  repo?: string;
  sessionId?: string;
  limit?: number;
}

export interface SearchIndex {
  indexTurns(turns: Turn[], sourcePath: string): void;
  removeSession(sessionId: string): void;
  search(query: string, opts?: IndexFilter): IndexSearchHit[];
  /** Stored doc fetch for ranking/packaging (may be stale — verify against adapters). */
  getTurnsByIds(ids: string[]): Turn[];
  /** Record a successful sync point (freshness signal, spec §35/§68). */
  markSynced(): void;
  stats(): IndexStats;
  close(): void;
}
