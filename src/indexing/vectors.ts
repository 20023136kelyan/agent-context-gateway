/**
 * LanceDB vector store for turn embeddings (Phase 2 semantic slice).
 * Disposable derived state: delete the dir and re-backfill from natives.
 * Cosine distance (embeddings are compared by angle, not magnitude).
 * Supports multi-model / dimension tables (e.g. turns_384 for MLX BGE-small,
 * turns_1024 for Ollama Qwen) so model swaps never crash with dimension mismatch.
 */
import * as lancedb from "@lancedb/lancedb";

export interface VectorHit {
  turnId: string;
  /** Cosine similarity in [-1, 1], higher is better. */
  similarity: number;
}

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
    filter?: { harness?: string; projectId?: string; sessionId?: string },
  ): Promise<VectorHit[]> {
    const dim = vector.length;
    const table = await this.getTableForDim(dim);
    if (!table) return [];

    let q = table.query().nearestTo(vector).distanceType("cosine").limit(limit);
    const preds: string[] = [];
    const esc = (s: string) => `'${s.replace(/'/g, "''")}'`;
    if (filter?.harness) preds.push(`harness = ${esc(filter.harness)}`);
    if (filter?.projectId) preds.push(`projectId = ${esc(filter.projectId)}`);
    if (filter?.sessionId) preds.push(`sessionId = ${esc(filter.sessionId)}`);
    if (preds.length) q = q.filter(preds.join(" AND "));
    const rows = await q.select(["id", "_distance"]).toArray();
    return (rows as { id: string; _distance: number }[]).map((r) => ({
      turnId: r.id,
      similarity: 1 - r._distance, // LanceDB cosine distance = 1 - cosine similarity
    }));
  }

  async close(): Promise<void> {
    this.tables.clear();
  }
}
