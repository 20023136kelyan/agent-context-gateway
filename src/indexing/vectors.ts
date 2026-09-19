/**
 * LanceDB vector store for turn embeddings (Phase 2 semantic slice).
 * Disposable derived state: delete the dir and re-backfill from natives.
 * Cosine distance (embeddings are compared by angle, not magnitude).
 * One table per ENGINE (turns_mlx_384, turns_voyage_1024), not per dimension.
 * Width is not an identity: Ollama's Qwen and a 1024-dim Voyage model are both
 * 1024 wide but are different vector spaces, and keying on width alone would
 * blend them into one table where every similarity is meaningless.
 */
import type * as lancedb from "@lancedb/lancedb";
import { createRequire } from "node:module";
import { chunkTurnId } from "../core/id.js";

// LanceDB publishes no darwin-x64 binary (support ended at 0.22.3). A static
// import therefore crashes the whole CLI on an Intel Mac, not merely semantic
// search, because app.ts imports this module. Requiring it lazily keeps the
// failure local to actually opening a Lance store.
const require = createRequire(import.meta.url);
function loadLance(): typeof import("@lancedb/lancedb") {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("@lancedb/lancedb") as typeof import("@lancedb/lancedb");
}
import type { EmbeddingEngine } from "../embeddings/provider.js";

/**
 * Tables written before storage was keyed by engine. Only these two engines
 * existed then, so the mapping is exact; honouring it saves re-embedding a
 * corpus that is already correct.
 */
const LEGACY_TABLE_ENGINE: Record<string, EmbeddingEngine> = {
  turns_384: "mlx",
  turns_1024: "ollama",
};

const tableName = (engine: EmbeddingEngine, dim: number) => `turns_${engine.replace(/-/g, "_")}_${dim}`;

/** What the retrieval path needs from a vector store, whichever backend serves it. */
export interface VectorBackend {
  count(): Promise<number>;
  upsert(rows: VectorRow[], engine: EmbeddingEngine): Promise<void>;
  optimize(): Promise<void>;
  maybeOptimize(threshold?: number): Promise<void>;
  existing(ids: string[], engine: EmbeddingEngine): Promise<Set<string>>;
  nearest(
    vector: number[],
    engine: EmbeddingEngine,
    limit?: number,
    filter?: { harness?: string; projectId?: string; sessionId?: string; maxTimestampMs?: number },
  ): Promise<VectorHit[]>;
  close(): Promise<void>;
}

export interface VectorRow {
  id: string;
  vector: number[];
  harness: string;
  sessionId: string;
  projectId: string;
  timestampMs: number;
}

export interface VectorHit {
  turnId: string;
  /** Cosine similarity in [-1, 1], higher is better. */
  similarity: number;
}

/**
 * A long turn owns several window rows, which would otherwise crowd distinct
 * turns out of the top K. Over-fetch by this factor, then collapse.
 */
const CHUNK_FANOUT = 4;

export class VectorStore implements VectorBackend {
  private db!: lancedb.Connection;
  private lance!: typeof import("@lancedb/lancedb");
  private tables = new Map<EmbeddingEngine, lancedb.Table>();
  private rowsSinceOptimize = 0;
  private constructor(private dir: string) {}

  static async open(dir: string): Promise<VectorStore> {
    const store = new VectorStore(dir);
    store.lance = loadLance();
    store.db = await store.lance.connect(dir);
    const names = await store.db.tableNames();
    for (const name of names) {
      const engine = store.engineForTable(name);
      if (!engine) continue;
      try {
        store.tables.set(engine, await store.db.openTable(name));
      } catch {
        // ignore — an unreadable table degrades to lexical, it does not throw
      }
      // The pre-dimension "turns" table (partial Ollama embeddings) is ignored.
    }
    return store;
  }

  /** Which engine owns a table name, current scheme or legacy. Null if neither. */
  private engineForTable(name: string): EmbeddingEngine | null {
    const legacy = LEGACY_TABLE_ENGINE[name];
    if (legacy) return legacy;
    const m = /^turns_(.+)_(\d+)$/.exec(name);
    if (!m) return null;
    return m[1].replace(/_/g, "-") as EmbeddingEngine;
  }

  private async tableFor(engine: EmbeddingEngine, dim?: number): Promise<lancedb.Table | null> {
    const open = this.tables.get(engine);
    if (open) return open;
    const names = await this.db.tableNames();
    // Prefer the current name; fall back to a legacy table this engine owns.
    const candidates = dim === undefined ? [] : [tableName(engine, dim)];
    for (const [legacyName, legacyEngine] of Object.entries(LEGACY_TABLE_ENGINE)) {
      if (legacyEngine === engine) candidates.push(legacyName);
    }
    for (const candidate of candidates) {
      if (names.includes(candidate)) {
        const tbl = await this.db.openTable(candidate);
        this.tables.set(engine, tbl);
        return tbl;
      }
    }
    return null;
  }

  async count(): Promise<number> {
    let total = 0;
    for (const tbl of this.tables.values()) {
      total += await tbl.countRows().catch(() => 0);
    }
    return total;
  }

  async upsert(
    rows: {
      id: string;
      vector: number[];
      harness: string;
      sessionId: string;
      projectId: string;
      timestampMs: number;
    }[],
    engine: EmbeddingEngine,
  ): Promise<void> {
    if (rows.length === 0) return;
    // Claude reuses uuids within one file, so a batch can carry an id twice and
    // mergeInsert rejects ambiguous matches outright. Last occurrence wins.
    const unique = [...new Map(rows.map((r) => [r.id, r])).values()];
    const dim = unique[0].vector.length;
    for (const r of unique) {
      if (r.vector.length !== dim) {
        throw new Error(`inconsistent vector dim: expected ${dim}, got ${r.vector.length}`);
      }
    }

    let table = await this.tableFor(engine, dim);
    if (!table) {
      table = await this.db.createTable(tableName(engine, dim), unique);
      this.tables.set(engine, table);
    } else {
      await table.mergeInsert("id").whenMatchedUpdateAll().whenNotMatchedInsertAll().execute(unique);
    }
    this.rowsSinceOptimize += unique.length;
  }

  /**
   * Compact small fragments and refresh indices; creates the scalar index on
   * `id` (dedup lookups) on first use. Best-effort: queries stay correct without it.
   */
  async optimize(): Promise<void> {
    for (const tbl of this.tables.values()) {
      try {
        const indices = await tbl.listIndices();
        if (!indices.some((i) => i.columns.includes("id"))) {
          await tbl.createIndex("id", { config: this.lance.Index.btree() });
        }
        await tbl.optimize();
      } catch {
        // ignore — an unoptimized table is slower, not wrong
      }
    }
    this.rowsSinceOptimize = 0;
  }

  /** optimize() once enough rows accumulated (for frequent small writers like the watcher). */
  async maybeOptimize(threshold = 5000): Promise<void> {
    if (this.rowsSinceOptimize >= threshold) await this.optimize();
  }

  /** IDs already embedded by this engine (incremental backfill of new turns only). */
  async existing(ids: string[], engine: EmbeddingEngine): Promise<Set<string>> {
    const table = await this.tableFor(engine);
    if (!table || ids.length === 0) return new Set();
    const found = new Set<string>();
    // Chunked: SQL IN lists stay small.
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const lit = chunk.map((id) => `'${id.replace(/'/g, "''")}'`).join(",");
      const rows = await table.query().filter(`id IN (${lit})`).select(["id"]).toArray();
      for (const r of rows as { id: string }[]) found.add(r.id);
    }
    return found;
  }

  async nearest(
    vector: number[],
    engine: EmbeddingEngine,
    limit = 50,
    filter?: { harness?: string; projectId?: string; sessionId?: string; maxTimestampMs?: number },
  ): Promise<VectorHit[]> {
    // Keyed by engine, never by vector.length: the query vector must be compared
    // against the table the SAME engine wrote, not merely one of equal width.
    const table = await this.tableFor(engine, vector.length);
    if (!table) return [];

    let q = table.query().nearestTo(vector).distanceType("cosine").limit(limit * CHUNK_FANOUT);
    const preds: string[] = [];
    const esc = (s: string) => `'${s.replace(/'/g, "''")}'`;
    if (filter?.harness) preds.push(`harness = ${esc(filter.harness)}`);
    if (filter?.projectId) preds.push(`projectId = ${esc(filter.projectId)}`);
    if (filter?.sessionId) preds.push(`sessionId = ${esc(filter.sessionId)}`);
    // Same bound as the lexical side: KNN returns its top-K from the whole
    // store, so without this a pinned query spends candidate slots on turns it
    // will discard, and the surviving pool shrinks as the corpus grows.
    if (Number.isFinite(filter?.maxTimestampMs)) preds.push(`timestampMs <= ${Math.floor(filter!.maxTimestampMs!)}`);
    if (preds.length) q = q.filter(preds.join(" AND "));
    const rows = await q.select(["id", "_distance"]).toArray();

    // Collapse windows to turns, keeping each turn's best-scoring window: a turn
    // is relevant when *any* part of it matches, and averaging would dilute the
    // strong local match that chunking exists to expose. Callers upstream index
    // turns by id, so a window id must never escape this method.
    const best = new Map<string, number>();
    for (const r of rows as { id: string; _distance: number }[]) {
      const turn = chunkTurnId(r.id);
      const similarity = 1 - r._distance; // LanceDB cosine distance = 1 - cosine similarity
      const prev = best.get(turn);
      if (prev === undefined || similarity > prev) best.set(turn, similarity);
    }
    return [...best.entries()]
      .map(([turnId, similarity]) => ({ turnId, similarity }))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit);
  }

  async close(): Promise<void> {
    this.tables.clear();
  }
}
