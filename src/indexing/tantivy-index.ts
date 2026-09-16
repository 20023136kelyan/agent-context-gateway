/**
 * Tantivy lexical index (MVP backend).
 * Disposable: delete index dir + rebuild from native histories.
 * Uses @pngwasi/node-tantivy-binding (Tantivy engine, BM25, prebuilt binaries).
 *
 * Notes:
 * - Searchers are snapshots: every search path calls reload() then takes a
 *   fresh searcher, so readers always see the last commit.
 * - No native upsert: indexTurns deletes by exact `id` term (raw tokenizer)
 *   then re-adds. `id`/`harness`/`projectId`/`sessionId` use the `raw`
 *   tokenizer so term filters and deletes match exactly.
 * - Commits are expensive (segment flush + reload): a sync pass writes every
 *   session with `{ commit: false }` and commits once at the end.
 * - Single writer per index dir per process (Tantivy directory lock):
 *   share ONE TantivyIndex/SearchService instance across CLI/HTTP/MCP.
 *   Concurrent opens of the same dir fail with LockBusy.
 */
import { mkdirSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import type { Turn } from "../core/models.js";
import type { IndexStats, SearchIndex, IndexSearchHit, IndexWriteOptions, IndexFilter } from "./types.js";

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const tantivy = require("@pngwasi/node-tantivy-binding") as typeof import("@pngwasi/node-tantivy-binding");

const { SchemaBuilder, Index, Document, Query, Occur } = tantivy;

type TantivyIndexHandle = InstanceType<typeof Index>;

export function buildSchema() {
  return new SchemaBuilder()
    .addTextField("id", { stored: true, tokenizerName: "raw" })
    .addTextField("content", { stored: true })
    .addTextField("harness", { stored: true, tokenizerName: "raw" })
    .addTextField("projectId", { stored: true, tokenizerName: "raw" })
    .addTextField("repo", { stored: true, tokenizerName: "raw" })
    .addTextField("sessionId", { stored: true, tokenizerName: "raw" })
    .addTextField("role", { stored: true, tokenizerName: "raw" })
    .addTextField("workspace", { stored: true })
    .addTextField("fileRefs", { stored: true })
    .addTextField("sourcePath", { stored: true, tokenizerName: "raw" })
    .addIntegerField("timestampMs", { stored: true, indexed: true })
    .addIntegerField("byteOffset", { stored: true })
    .build();
}

let sharedSchema: ReturnType<typeof buildSchema> | null = null;

/** The schema is immutable: build it once instead of per query. */
function schema(): ReturnType<typeof buildSchema> {
  return (sharedSchema ??= buildSchema());
}

function isEmptyDir(dir: string): boolean {
  try {
    return readdirSync(dir).length === 0;
  } catch {
    return true;
  }
}

/** Claude reuses uuids within one file — dedupe batch ids before delta math. */
function uniqueInBatch(list: Turn[]): Turn[] {
  const seen = new Set<string>();
  return list.filter((t) => (seen.has(t.id) ? false : (seen.add(t.id), true)));
}

function docToTurn(doc: { getFirst(field: string): unknown }): Turn {
  const num = (v: unknown) => (typeof v === "number" ? v : Number(v ?? 0));
  const str = (v: unknown) => (typeof v === "string" ? v : String(v ?? ""));
  const off = num(doc.getFirst("byteOffset"));
  return {
    id: str(doc.getFirst("id")),
    sessionId: str(doc.getFirst("sessionId")),
    harness: str(doc.getFirst("harness")) as Turn["harness"],
    timestamp: new Date(num(doc.getFirst("timestampMs")) || 0).toISOString(),
    role: str(doc.getFirst("role")) as Turn["role"],
    content: str(doc.getFirst("content")),
    raw: {},
    fileRefs: JSON.parse(str(doc.getFirst("fileRefs")) || "[]"),
    seq: 0,
    byteOffset: off >= 0 ? off : undefined,
  };
}

export class TantivyIndex implements SearchIndex {
  private index: TantivyIndexHandle;
  /**
   * Lazily created: readers (search/stats/get) never take the directory
   * lock, so CLI/MCP/serve can all hold the index open concurrently.
   * Only writers (indexTurns/removeSession) contend — and sync paths are
   * brief. Throws LockBusy with a clear message when another writer runs.
   */
  private writer: InstanceType<typeof tantivy.IndexWriter> | null = null;
  /** Per-harness doc counts: loaded from gateway-meta.json on first write, saved on commit. */
  private counts: Record<string, number> | null = null;
  private uncommitted = false;
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
    if (isEmptyDir(dir)) {
      this.index = new Index(schema(), dir);
    } else {
      try {
        this.index = Index.open(dir);
      } catch {
        this.index = new Index(schema(), dir);
      }
    }
  }

  private ensureWriter(): InstanceType<typeof tantivy.IndexWriter> {
    if (!this.writer) {
      try {
        this.writer = this.index.writer(50_000_000);
      } catch (e) {
        throw new Error(
          `index busy: another gateway writer (serve --watch?) holds ${this.dir}. Retry, or run writes through the live server.`,
        );
      }
    }
    return this.writer;
  }

  private loadCounts(): Record<string, number> {
    return (this.counts ??= { ...(this.readMeta().counts ?? {}) });
  }

  indexTurns(turns: Turn[], sourcePath: string, opts: IndexWriteOptions = {}): void {
    const writer = this.ensureWriter();
    // O(1) per-harness counts: ids already committed are replaced (upsert),
    // so only the rest of the batch adds to its harness count.
    const counts = this.loadCounts();
    const searcher = this.index.searcher();
    const bySession = new Map<string, Turn[]>();
    for (const t of turns) {
      const list = bySession.get(t.sessionId) ?? [];
      list.push(t);
      bySession.set(t.sessionId, list);
    }
    for (const list of bySession.values()) {
      const uniq = uniqueInBatch(list);
      let present = 0;
      try {
        // Chunked: giant sessions exceed Tantivy's boolean clause limit.
        for (let i = 0; i < uniq.length; i += 500) {
          const chunk = uniq.slice(i, i + 500);
          present += searcher.search(Query.termSetQuery(schema(), "id", chunk.map((t) => t.id)), chunk.length, false).hits.length;
        }
      } catch {
        // counts best-effort; docCount stays exact
      }
      const h = list[0].harness;
      counts[h] = (counts[h] ?? 0) + (uniq.length - present);
    }
    for (const t of turns) {
      const extra = t as Turn & { projectId?: string; workspace?: string; repo?: string | null };
      // Upsert via delete-then-add on exact id term.
      writer.deleteDocumentsByTerm("id", t.id);
      const doc = new Document();
      doc.addText("id", t.id);
      doc.addText("content", t.content);
      doc.addText("harness", t.harness);
      doc.addText("projectId", extra.projectId ?? "unknown");
      doc.addText("repo", extra.repo ?? "");
      doc.addText("sessionId", t.sessionId);
      doc.addText("role", t.role);
      doc.addText("workspace", extra.workspace ?? "");
      doc.addText("fileRefs", JSON.stringify(t.fileRefs ?? []));
      doc.addText("sourcePath", sourcePath);
      doc.addInteger("timestampMs", Date.parse(t.timestamp) || 0);
      doc.addInteger("byteOffset", t.byteOffset ?? -1);
      writer.addDocument(doc);
    }
    this.uncommitted = true;
    if (opts.commit !== false) this.commit();
  }

  commit(): void {
    if (!this.uncommitted) return;
    this.ensureWriter().commit();
    this.index.reload();
    this.uncommitted = false;
    if (this.counts) this.writeMeta({ counts: this.counts });
  }

  removeSession(sessionId: string): void {
    // Decrement counts from stored docs before deleting (session-scoped scan).
    try {
      this.index.reload();
      const searcher = this.index.searcher();
      const res = searcher.search(Query.termQuery(schema(), "sessionId", sessionId), 100000, false);
      const counts = this.loadCounts();
      for (const h of res.hits) {
        const hw = searcher.doc(h.docAddress).getFirst("harness");
        const name = typeof hw === "string" ? hw : "unknown";
        counts[name] = Math.max(0, (counts[name] ?? 1) - 1);
      }
    } catch {
      // counts best-effort; docCount stays exact
    }
    this.ensureWriter().deleteDocumentsByQuery(Query.termQuery(schema(), "sessionId", sessionId));
    this.uncommitted = true;
    this.commit();
  }

  search(query: string, opts?: IndexFilter): IndexSearchHit[] {
    if (!query.trim()) return [];
    const clauses: object[] = [];
    // Lenient parse: unknown operators become errors list instead of throwing.
    const [textQuery] = this.index.parseQueryLenient(query, ["content"]);
    clauses.push({ occur: Occur.Must, query: textQuery });
    if (opts?.harness) clauses.push({ occur: Occur.Must, query: Query.termQuery(schema(), "harness", opts.harness) });
    if (opts?.projectId)
      clauses.push({ occur: Occur.Must, query: Query.termQuery(schema(), "projectId", opts.projectId) });
    if (opts?.repo) clauses.push({ occur: Occur.Must, query: Query.termQuery(schema(), "repo", opts.repo) });
    if (opts?.sessionId)
      clauses.push({ occur: Occur.Must, query: Query.termQuery(schema(), "sessionId", opts.sessionId) });
    if (opts?.maxTimestampMs !== undefined) {
      // Bounds the corpus before `limit` rather than after, so an asOf query
      // does not lose recall to newer turns taking candidate slots.
      // FieldType is a `const enum`: erased at runtime (the module exports {}),
      // so the type comes from the schema, never from `FieldType.I64`.
      const s = schema();
      clauses.push({
        occur: Occur.Must,
        query: Query.rangeQuery(s, "timestampMs", s.getFieldType("timestampMs"), 0, opts.maxTimestampMs, true, true),
      });
    }
    const combined = clauses.length === 1 ? textQuery : Query.booleanQuery(clauses);
    this.index.reload();
    const searcher = this.index.searcher();
    const res = searcher.search(combined, opts?.limit ?? 50, false);
    const hits: IndexSearchHit[] = [];
    for (const h of res.hits) {
      const doc = searcher.doc(h.docAddress);
      const turnId = doc.getFirst("id") as string;
      if (turnId) hits.push({ turnId, score: h.score ?? 0 });
    }
    return hits;
  }

  /** Fetch stored docs for packaging, in input order (one id-set query per 500 ids). */
  getTurnsByIds(ids: string[]): Turn[] {
    if (ids.length === 0) return [];
    this.index.reload();
    const searcher = this.index.searcher();
    const byId = new Map<string, Turn>();
    const unique = [...new Set(ids)];
    for (let i = 0; i < unique.length; i += 500) {
      const chunk = unique.slice(i, i + 500);
      const res = searcher.search(Query.termSetQuery(schema(), "id", chunk), chunk.length, false);
      for (const h of res.hits) {
        const turn = docToTurn(searcher.doc(h.docAddress));
        byId.set(turn.id, turn);
      }
    }
    return ids.flatMap((id) => {
      const t = byId.get(id);
      return t ? [t] : [];
    });
  }

  existingIds(ids: string[]): Set<string> {
    const found = new Set<string>();
    if (ids.length === 0) return found;
    this.index.reload();
    const searcher = this.index.searcher();
    // Chunked: giant sessions exceed Tantivy's boolean clause limit.
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const res = searcher.search(Query.termSetQuery(schema(), "id", chunk), chunk.length, false);
      for (const h of res.hits) {
        const id = searcher.doc(h.docAddress).getFirst("id");
        if (typeof id === "string") found.add(id);
      }
    }
    return found;
  }

  docCount(): number {
    this.index.reload();
    return this.index.searcher().numDocs;
  }

  stats(): IndexStats {
    const meta = this.readMeta();
    return {
      docCount: this.docCount(),
      lastSync: meta.lastSync,
      perHarness: this.counts ?? meta.counts ?? {},
    };
  }

  private readMeta(): { lastSync?: string; counts?: Record<string, number> } {
    try {
      return JSON.parse(readFileSync(join(this.dir, "gateway-meta.json"), "utf8")) as {
        lastSync?: string;
        counts?: Record<string, number>;
      };
    } catch {
      return {};
    }
  }

  private writeMeta(patch: { lastSync?: string; counts?: Record<string, number> }): void {
    try {
      writeFileSync(join(this.dir, "gateway-meta.json"), JSON.stringify({ ...this.readMeta(), lastSync: new Date().toISOString(), ...patch }));
    } catch {
      // freshness marker is best-effort
    }
  }

  markSynced(): void {
    this.writeMeta({});
  }

  close(): void {
    try {
      this.commit();
      this.writer?.waitMergingThreads();
    } catch {
      // best-effort release of the directory lock
    } finally {
      this.writer = null;
    }
  }
}

export function defaultIndexDir(): string {
  const home = process.env.HOME ?? "/tmp";
  const dir = join(home, ".context-gateway", "index-tantivy");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}
