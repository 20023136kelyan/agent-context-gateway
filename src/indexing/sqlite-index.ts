/**
 * SQLite FTS5 lexical index (MVP backend). DEPRECATED PATH — the locked stack
 * is Tantivy + LanceDB; this backend is unmaintained fallback only and takes
 * no part in sweeps. Kept compiling so app wiring and its tests keep working.
 * Disposable: delete index dir + rebuild from native histories.
 * Uses node:sqlite (built-in, SQLite 3.51 + FTS5 porter tokenizer).
 */
import { mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import type { Turn } from "../core/models.js";
import type { IndexStats, SearchIndex, IndexSearchHit, IndexFilter, IndexWriteOptions } from "./types.js";
import { STOP } from "../search/query.js";

// node:sqlite is experimental: Vite/Vitest strips static `node:` imports
// during transform ("Failed to load url sqlite"), and importing it prints an
// ExperimentalWarning. Load lazily inside the constructor so the Tantivy
// (default) path never touches it.
const require = createRequire(import.meta.url);
type DatabaseSyncType = typeof import("node:sqlite")["DatabaseSync"];
function loadDatabaseSync(): DatabaseSyncType {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return (require("node:sqlite") as typeof import("node:sqlite")).DatabaseSync;
}

export function sanitizeFtsQuery(q: string): string {
  // Extract alphanumeric terms (keep # for PR numbers), drop FTS5 operators.
  // "What did Codex decide about PR #169?" -> '"what" "did" "codex" "decide" "about" "pr" "169"'
  const terms = q.toLowerCase().match(/[a-z0-9#]+/g) ?? [];
  const kept = terms.map((t) => t.replace(/#/g, "")).filter((t) => t.length >= 2 && t && !STOP.has(t));
  if (kept.length === 0) return "";
  return kept.map((t) => `"${t.replace(/"/g, "")}"`).join(" ");
}

export class SqliteIndex implements SearchIndex {
  private db: InstanceType<DatabaseSyncType>;
  private inTransaction = false;
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
    this.db = new (loadDatabaseSync())(join(dir, "index.db"));
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS docs(
        id TEXT PRIMARY KEY,
        harness TEXT NOT NULL,
        sessionId TEXT NOT NULL,
        projectId TEXT NOT NULL,
        repo TEXT NOT NULL DEFAULT '',
        workspace TEXT NOT NULL,
        timestampMs INTEGER NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        fileRefs TEXT NOT NULL,
        sourcePath TEXT NOT NULL,
        byteOffset INTEGER
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(
        content, content='docs', content_rowid='rowid', tokenize='porter'
      );
      CREATE TRIGGER IF NOT EXISTS docs_ai AFTER INSERT ON docs BEGIN
        INSERT INTO docs_fts(rowid, content) VALUES (new.rowid, new.content);
      END;
      CREATE TRIGGER IF NOT EXISTS docs_ad AFTER DELETE ON docs BEGIN
        INSERT INTO docs_fts(docs_fts, rowid, content) VALUES('delete', old.rowid, old.content);
      END;
      CREATE INDEX IF NOT EXISTS idx_docs_session ON docs(sessionId);
      CREATE INDEX IF NOT EXISTS idx_docs_harness ON docs(harness);
      CREATE INDEX IF NOT EXISTS idx_docs_project ON docs(projectId);
      CREATE INDEX IF NOT EXISTS idx_docs_repo ON docs(repo);
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
    `);
    // External-content FTS needs an UPDATE trigger too: upserts (ON CONFLICT DO
    // UPDATE) otherwise leave the old tokens indexed under the row.
    const hadUpdateTrigger = !!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='docs_au'").get();
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS docs_au AFTER UPDATE ON docs BEGIN
        INSERT INTO docs_fts(docs_fts, rowid, content) VALUES('delete', old.rowid, old.content);
        INSERT INTO docs_fts(rowid, content) VALUES (new.rowid, new.content);
      END;
    `);
    // Databases written before the trigger may hold stale FTS rows: rebuild once.
    if (!hadUpdateTrigger) this.db.exec("INSERT INTO docs_fts(docs_fts) VALUES('rebuild')");
    // Migrate pre-repo databases (SQLite has no ADD COLUMN IF NOT EXISTS).
    try {
      this.db.exec("ALTER TABLE docs ADD COLUMN repo TEXT NOT NULL DEFAULT ''");
    } catch {
      // column already present
    }
  }

  indexTurns(turns: Turn[], sourcePath: string, opts: IndexWriteOptions = {}): void {
    // One transaction per batch (or per sync pass with commit:false): autocommit
    // per row would fsync every insert.
    if (!this.inTransaction) {
      this.db.exec("BEGIN");
      this.inTransaction = true;
    }
    try {
      this.insertTurns(turns, sourcePath);
    } catch (e) {
      this.db.exec("ROLLBACK");
      this.inTransaction = false;
      throw e;
    }
    if (opts.commit !== false) this.commit();
  }

  commit(): void {
    if (!this.inTransaction) return;
    this.db.exec("COMMIT");
    this.inTransaction = false;
  }

  docCount(): number {
    return (this.db.prepare("SELECT COUNT(*) as c FROM docs").get() as { c: number }).c;
  }

  private insertTurns(turns: Turn[], sourcePath: string): void {
    const stmt = this.db.prepare(`
      INSERT INTO docs(id,harness,sessionId,projectId,repo,workspace,timestampMs,role,content,fileRefs,sourcePath,byteOffset)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        content=excluded.content, timestampMs=excluded.timestampMs,
        fileRefs=excluded.fileRefs, sourcePath=excluded.sourcePath, byteOffset=excluded.byteOffset,
        repo=excluded.repo, projectId=excluded.projectId
    `);
    // Need session project/workspace lookup: turns don't carry projectId.
    // Caller passes enriched turns; here we read projectId from a side map if present.
    for (const t of turns) {
      const extra = t as Turn & { projectId?: string; workspace?: string; repo?: string | null };
      stmt.run(
        t.id,
        t.harness,
        t.sessionId,
        extra.projectId ?? "unknown",
        extra.repo ?? "",
        extra.workspace ?? "",
        Date.parse(t.timestamp) || 0,
        t.role,
        t.content,
        JSON.stringify(t.fileRefs ?? []),
        sourcePath,
        t.byteOffset ?? null,
      );
    }
    this.setMeta("lastSync", new Date().toISOString());
  }

  removeSession(sessionId: string): void {
    this.db.prepare("DELETE FROM docs WHERE sessionId=?").run(sessionId);
  }

  search(query: string, opts?: IndexFilter): IndexSearchHit[] {
    const match = sanitizeFtsQuery(query);
    if (!match) return [];
    const filters: string[] = [];
    const params: (string | number | bigint | null)[] = [];
    if (opts?.harness) {
      filters.push("d.harness=?");
      params.push(opts.harness);
    }
    if (opts?.projectId) {
      filters.push("d.projectId=?");
      params.push(opts.projectId);
    }
    if (opts?.repo) {
      filters.push("d.repo=?");
      params.push(opts.repo);
    }
    if (opts?.sessionId) {
      filters.push("d.sessionId=?");
      params.push(opts.sessionId);
    }
    if (opts?.sessionIds) {
      if (opts.sessionIds.length === 0) return [];
      filters.push(`d.sessionId IN (${opts.sessionIds.map(() => "?").join(",")})`);
      params.push(...opts.sessionIds);
    }
    // Bounds the corpus before LIMIT, so an asOf query keeps its recall.
    if (opts?.maxTimestampMs !== undefined) {
      filters.push("d.timestampMs<=?");
      params.push(opts.maxTimestampMs);
    }
    const where = filters.length ? `AND ${filters.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `SELECT d.id as turnId, -bm25(docs_fts) as score
         FROM docs d JOIN docs_fts f ON d.rowid=f.rowid
         WHERE docs_fts MATCH ? ${where}
         ORDER BY score DESC LIMIT ?`,
      )
      .all(match, ...params, opts?.limit ?? 50) as unknown as IndexSearchHit[];
    return rows;
  }

  /** Fetch full doc rows for packaging (search layer joins in-memory). */
  getTurnsByIds(ids: string[]): Turn[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.db
      .prepare(`SELECT * FROM docs WHERE id IN (${placeholders})`)
      .all(...ids) as Record<string, unknown>[];
    const byId = new Map(rows.map((r) => [r.id as string, r]));
    return ids.flatMap((id) => {
      const r = byId.get(id);
      if (!r) return [];
      return [
        {
          id: r.id as string,
          sessionId: r.sessionId as string,
          harness: r.harness as Turn["harness"],
          timestamp: new Date((r.timestampMs as number) || 0).toISOString(),
          role: r.role as Turn["role"],
          content: r.content as string,
          raw: {},
          fileRefs: JSON.parse((r.fileRefs as string) || "[]"),
          seq: 0,
          byteOffset: (r.byteOffset as number | null) ?? undefined,
        } satisfies Turn,
      ];
    });
  }

  existingIds(ids: string[]): Set<string> {
    const found = new Set<string>();
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const rows = this.db
        .prepare(`SELECT id FROM docs WHERE id IN (${chunk.map(() => "?").join(",")})`)
        .all(...chunk) as { id: string }[];
      for (const r of rows) found.add(r.id);
    }
    return found;
  }

  stats(): IndexStats {
    const total = this.docCount();
    const per = this.db.prepare("SELECT harness, COUNT(*) as c FROM docs GROUP BY harness").all() as {
      harness: string;
      c: number;
    }[];
    return {
      docCount: total,
      lastSync: this.getMeta("lastSync") ?? undefined,
      perHarness: Object.fromEntries(per.map((p) => [p.harness, p.c])),
    };
  }

  private getMeta(key: string): string | null {
    try {
      const row = this.db.prepare("SELECT value FROM meta WHERE key=?").get(key) as { value: string } | undefined;
      return row?.value ?? null;
    } catch {
      return null;
    }
  }

  private setMeta(key: string, value: string): void {
    this.db.prepare("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
  }

  close(): void {
    this.commit();
    this.db.close();
  }

  markSynced(): void {
    this.setMeta("lastSync", new Date().toISOString());
  }
}

export function defaultIndexDir(): string {
  const home = process.env.HOME ?? "/tmp";
  const dir = join(home, ".context-gateway", "index-sqlite");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export { dirname };
