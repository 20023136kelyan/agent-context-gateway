/**
 * sqlite-vec vector store — the portable backend.
 *
 * LanceDB publishes no darwin-x64 binary (support ended at 0.22.3), so on an
 * Intel Mac the Lance backend cannot load at all. This backend runs anywhere
 * SQLite does, reusing the same `node:sqlite` the FTS5 lexical index already
 * depends on.
 *
 * Two properties matter more than raw speed:
 *   - Filters live INSIDE the query, beside `k`. A vec0 KNN with `timestampMs
 *     <= ?` in the same WHERE clause cannot spend candidate slots on rows it
 *     will discard, which is the failure `asOf` hit when it post-filtered.
 *   - Identity is the ENGINE, not the width. One vec0 table per engine, so two
 *     1024-dim models never share a table.
 *
 * Search is brute force: vec0 has no ANN index. Measured on this machine at
 * 139,403 rows x 384 dims, in memory: ~119 ms for k=200, ~74 ms with a
 * timestamp bound (the bound shrinks the scan). Cost grows linearly with the
 * corpus and with dimension.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { chunkTurnId } from "../core/id.js";
import type { EmbeddingEngine } from "../embeddings/provider.js";
import type { VectorHit } from "./vectors.js";

// node:sqlite is experimental and Vitest's transform strips static `node:`
// imports, so both it and the extension load lazily — the same shape
// sqlite-index.ts uses for exactly this reason.
const require = createRequire(import.meta.url);
type DatabaseSyncType = typeof import("node:sqlite")["DatabaseSync"];
function loadDatabaseSync(): DatabaseSyncType {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return (require("node:sqlite") as typeof import("node:sqlite")).DatabaseSync;
}
function loadVecExtension(db: { loadExtension(p: string): void }): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const vec = require("sqlite-vec") as { load(db: unknown): void };
  vec.load(db);
}

/** A long turn owns several window rows; over-fetch then collapse to turns. */
const CHUNK_FANOUT = 4;

export interface VectorRow {
  id: string;
  vector: number[];
  harness: string;
  sessionId: string;
  projectId: string;
  timestampMs: number;
}

const tableName = (engine: EmbeddingEngine, dim: number) => `turns_${engine.replace(/-/g, "_")}_${dim}`;

export class SqliteVectorStore {
  private db!: InstanceType<DatabaseSyncType>;
  /** engine -> its vec0 table name, discovered on open or created on write. */
  private tables = new Map<EmbeddingEngine, string>();
  private constructor(private dir: string) {}

  static async open(dir: string): Promise<SqliteVectorStore> {
    const store = new SqliteVectorStore(dir);
    mkdirSync(dir, { recursive: true });
    const DatabaseSync = loadDatabaseSync();
    store.db = new DatabaseSync(join(dir, "vectors.db"), { allowExtension: true });
    loadVecExtension(store.db as unknown as { loadExtension(p: string): void });
    store.db.exec("PRAGMA journal_mode = WAL");
    // vec0 spawns shadow tables (_info, _chunks, _rowids, _vector_chunks00);
    // matching on the CREATE statement keeps those out of the engine map.
    const rows = store.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND sql LIKE '%USING vec0%'")
      .all() as { name: string }[];
    for (const { name } of rows) {
      const engine = engineForTable(name);
      if (engine) store.tables.set(engine, name);
    }
    return store;
  }

  private tableFor(engine: EmbeddingEngine): string | null {
    return this.tables.get(engine) ?? null;
  }

  private ensureTable(engine: EmbeddingEngine, dim: number): string {
    const existing = this.tableFor(engine);
    if (existing) return existing;
    const name = tableName(engine, dim);
    // Metadata columns are queryable in the same WHERE as the KNN match.
    this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ${name} USING vec0(
      id TEXT PRIMARY KEY,
      harness TEXT,
      sessionId TEXT,
      projectId TEXT,
      timestampMs INTEGER,
      embedding float[${dim}] distance_metric=cosine
    )`);
    this.tables.set(engine, name);
    return name;
  }

  async count(): Promise<number> {
    let total = 0;
    for (const name of this.tables.values()) {
      try {
        total += Number((this.db.prepare(`SELECT count(*) AS c FROM ${name}`).get() as { c: number }).c);
      } catch {
        // an unreadable table degrades to lexical, it does not throw
      }
    }
    return total;
  }

  async upsert(rows: VectorRow[], engine: EmbeddingEngine): Promise<void> {
    if (rows.length === 0) return;
    // Claude reuses turn uuids within one file, so a batch can carry an id
    // twice. Last occurrence wins, before SQLite ever sees the duplicate.
    const unique = [...new Map(rows.map((r) => [r.id, r])).values()];
    const dim = unique[0].vector.length;
    for (const r of unique) {
      if (r.vector.length !== dim) {
        throw new Error(`inconsistent vector dim: expected ${dim}, got ${r.vector.length}`);
      }
    }
    const name = this.ensureTable(engine, dim);
    // vec0 implements neither ON CONFLICT nor INSERT OR REPLACE, so replace is
    // delete-then-insert. One transaction keeps a crash from losing the old row
    // without writing the new one.
    const del = this.db.prepare(`DELETE FROM ${name} WHERE id = ?`);
    const ins = this.db.prepare(
      `INSERT INTO ${name}(id, harness, sessionId, projectId, timestampMs, embedding) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    this.db.exec("BEGIN");
    try {
      for (const r of unique) {
        del.run(r.id);
        // INTEGER columns reject a JS number (bound as FLOAT); BigInt is required.
        ins.run(r.id, r.harness, r.sessionId, r.projectId, BigInt(Math.floor(r.timestampMs)), new Float32Array(r.vector));
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /** No ANN index to rebuild; reclaim pages and refresh planner stats. */
  async optimize(): Promise<void> {
    try {
      this.db.exec("PRAGMA optimize");
    } catch {
      // ignore — an unoptimized store is slower, not wrong
    }
  }

  async maybeOptimize(_threshold = 5000): Promise<void> {
    // No fragment compaction to schedule: writes go straight into the b-tree.
  }

  /** IDs already embedded by this engine (incremental backfill of new turns only). */
  async existing(ids: string[], engine: EmbeddingEngine): Promise<Set<string>> {
    const name = this.tableFor(engine);
    const found = new Set<string>();
    if (!name || ids.length === 0) return found;
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const holes = chunk.map(() => "?").join(",");
      const rows = this.db.prepare(`SELECT id FROM ${name} WHERE id IN (${holes})`).all(...chunk) as { id: string }[];
      for (const r of rows) found.add(r.id);
    }
    return found;
  }

  async nearest(
    vector: number[],
    engine: EmbeddingEngine,
    limit = 50,
    filter?: { harness?: string; projectId?: string; sessionId?: string; maxTimestampMs?: number },
  ): Promise<VectorHit[]> {
    // Keyed by engine, never by vector.length: a query vector is only
    // comparable against the table the SAME engine wrote.
    const name = this.tableFor(engine);
    if (!name) return [];

    const preds: string[] = [];
    const args: (string | bigint)[] = [];
    if (filter?.harness) { preds.push("harness = ?"); args.push(filter.harness); }
    if (filter?.projectId) { preds.push("projectId = ?"); args.push(filter.projectId); }
    if (filter?.sessionId) { preds.push("sessionId = ?"); args.push(filter.sessionId); }
    // Same bound as the lexical side, and inside the query rather than after
    // it: KNN returns its top-k from the whole table, so a post-filter would
    // spend candidate slots on rows it then discards.
    if (Number.isFinite(filter?.maxTimestampMs)) {
      preds.push("timestampMs <= ?");
      args.push(BigInt(Math.floor(filter!.maxTimestampMs!)));
    }
    // k is interpolated, not bound: vec0 requires a literal constraint here.
    const k = Math.max(1, Math.floor(limit * CHUNK_FANOUT));
    const where = ["embedding MATCH ?", `k = ${k}`, ...preds].join(" AND ");
    const rows = this.db
      .prepare(`SELECT id, distance FROM ${name} WHERE ${where} ORDER BY distance`)
      .all(new Float32Array(vector), ...args) as { id: string; distance: number }[];

    // Collapse windows to turns, keeping each turn's best window: a turn is
    // relevant when *any* part of it matches, and averaging would dilute the
    // strong local match chunking exists to expose.
    const best = new Map<string, number>();
    for (const r of rows) {
      const turn = chunkTurnId(r.id);
      const similarity = 1 - r.distance; // cosine distance = 1 - cosine similarity
      const prev = best.get(turn);
      if (prev === undefined || similarity > prev) best.set(turn, similarity);
    }
    return [...best.entries()]
      .map(([turnId, similarity]) => ({ turnId, similarity }))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit);
  }

  async close(): Promise<void> {
    try {
      this.db.close();
    } catch {
      // already closed
    }
    this.tables.clear();
  }
}

function engineForTable(name: string): EmbeddingEngine | null {
  const m = /^turns_(.+)_(\d+)$/.exec(name);
  if (!m) return null;
  return m[1].replace(/_/g, "-") as EmbeddingEngine;
}
