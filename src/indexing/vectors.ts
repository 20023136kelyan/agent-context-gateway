/**
 * LanceDB vector store for turn embeddings (Phase 2 semantic slice).
 * Disposable derived state: delete the dir and re-backfill from natives.
 * Cosine distance (embeddings are compared by angle, not magnitude).
 * Supports multi-model / dimension tables (e.g. turns_384 for MLX BGE-small,
 * turns_1024 for Ollama Qwen) so model swaps never crash with dimension mismatch.
 */
import * as lancedb from "@lancedb/lancedb";
import { chunkTurnId } from "../core/id.js";

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

export class VectorStore {
  private db!: lancedb.Connection;
  private tables = new Map<number, lancedb.Table>();
  private defaultDim = 384;
  private rowsSinceOptimize = 0;
  private constructor(private dir: string) {}

  static async open(dir: string): Promise<VectorStore> {
    const store = new VectorStore(dir);
    store.db = await lancedb.connect(dir);
    const names = await store.db.tableNames();
    for (const name of names) {
      if (name.startsWith("turns_")) {
        const dim = Number(name.replace("turns_", ""));
        if (Number.isFinite(dim) && dim > 0) {
          try {
            store.tables.set(dim, await store.db.openTable(name));
          } catch {
            // ignore
          }
        }
      }
      // The pre-dimension "turns" table (partial Ollama embeddings) is ignored.
    }
    return store;
  }

  private async getTableForDim(dim: number): Promise<lancedb.Table | null> {
    const existing = this.tables.get(dim);
    if (existing) return existing;
    const names = await this.db.tableNames();
    const candidateName = `turns_${dim}`;
    if (names.includes(candidateName)) {
      const tbl = await this.db.openTable(candidateName);
      this.tables.set(dim, tbl);
      return tbl;
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

    let table = await this.getTableForDim(dim);
    if (!table) {
      const tableName = `turns_${dim}`;
      table = await this.db.createTable(tableName, unique);
      this.tables.set(dim, table);
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
          await tbl.createIndex("id", { config: lancedb.Index.btree() });
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

  /** IDs already embedded in the `dim` table (incremental backfill of new turns only). */
  async existing(ids: string[], dim: number): Promise<Set<string>> {
    const table = await this.getTableForDim(dim);
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
    limit = 50,
    filter?: { harness?: string; projectId?: string; sessionId?: string; maxTimestampMs?: number },
  ): Promise<VectorHit[]> {
    const dim = vector.length;
    const table = await this.getTableForDim(dim);
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
