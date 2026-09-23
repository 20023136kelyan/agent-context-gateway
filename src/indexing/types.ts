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
  /**
   * Restrict to these sessions. How cross-harness `project` scoping reaches the
   * backend: projects are matched per session at query time (core/project.ts),
   * then passed down as ids, so `limit` selects inside the project rather than
   * spending candidate slots on other projects. An empty array matches nothing.
   */
  sessionIds?: string[];
  limit?: number;
  /**
   * Inclusive upper bound (epoch ms) on a turn's timestamp. Applied inside the
   * backend query so that `limit` selects from the bounded corpus. Filtering
   * after the search instead silently loses recall: newer turns take candidate
   * slots and are then discarded, so the same `asOf` returns fewer results as
   * the index grows.
   */
  maxTimestampMs?: number;
}

export interface IndexWriteOptions {
  /** false = leave the batch uncommitted; call commit() once after many batches (one sync pass). */
  commit?: boolean;
}

export interface SearchIndex {
  indexTurns(turns: Turn[], sourcePath: string, opts?: IndexWriteOptions): void;
  /** Make deferred writes durable and visible to searches. No-op when nothing is pending. */
  commit(): void;
  /** Live document count (cheap; no stats scan). */
  docCount(): number;
  removeSession(sessionId: string): void;
  search(query: string, opts?: IndexFilter): IndexSearchHit[];
  /** Stored doc fetch for ranking/packaging (may be stale — verify against adapters). */
  getTurnsByIds(ids: string[]): Turn[];
  /** Which of these turn ids are already indexed (new-turn detection for subscriptions). */
  existingIds(ids: string[]): Set<string>;
  /** Record a successful sync point (freshness signal, spec §35/§68). */
  markSynced(): void;
  stats(): IndexStats;
  close(): void;
}
