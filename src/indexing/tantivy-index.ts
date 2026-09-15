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
 * - Single writer per index dir per process (Tantivy directory lock):
 *   share ONE TantivyIndex/SearchService instance across CLI/HTTP/MCP.
 *   Concurrent opens of the same dir fail with LockBusy.
 */
import { mkdirSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import type { Turn } from "../core/models.js";
import type { IndexStats, SearchIndex, IndexSearchHit } from "./types.js";

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

export class TantivyIndex implements SearchIndex {
  private index: TantivyIndexHandle;
  /**
   * Lazily created: readers (search/stats/get) never take the directory
   * lock, so CLI/MCP/serve can all hold the index open concurrently.
   * Only writers (indexTurns/removeSession) contend — and sync paths are
   * brief. Throws LockBusy with a clear message when another writer runs.
   */
  private writer: InstanceType<typeof tantivy.IndexWriter> | null = null;
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
    const schema = buildSchema();
    if (isEmptyDir(dir)) {
      this.index = new Index(schema, dir);
    } else {
      try {
        this.index = Index.open(dir);
      } catch {
        this.index = new Index(schema, dir);
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

  indexTurns(turns: Turn[], sourcePath: string): void {
    // Baseline for O(1) per-harness counts: ids present BEFORE this batch.
    // (Upsert replaces, so delta = batch size minus baseline.)
    const baseline = new Map<string, number>();
    try {
      const schema = buildSchema();
      const searcher = this.index.searcher();
      const bySession = new Map<string, Turn[]>();
      for (const t of turns) {
        const list = bySession.get(t.sessionId) ?? [];
        list.push(t);
        bySession.set(t.sessionId, list);
      }
      for (const [sid, list] of bySession) {
        const uniq = uniqueInBatch(list);
        // Chunked: giant sessions exceed Tantivy's boolean clause limit.
        let present = 0;
        for (let i = 0; i < uniq.length; i += 500) {
          const chunk = uniq.slice(i, i + 500);
          const q = Query.termSetQuery(schema, "id", chunk.map((t) => t.id));
          present += searcher.search(q, chunk.length).hits.length;
        }
        baseline.set(sid, present);
      }
    } catch {
      // counts best-effort; docCount stays exact
    }
    for (const t of turns) {
      const extra = t as Turn & { projectId?: string; workspace?: string; repo?: string | null };
      // Upsert via delete-then-add on exact id term.
      const writer = this.ensureWriter();
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
      this.ensureWriter().addDocument(doc);
    }
    this.ensureWriter().commit();
    this.index.reload();
    // Maintain O(1) per-harness counts from the pre-batch baseline.
    try {
      const counts = this.readCounts();
      const bySession = new Map<string, Turn[]>();
      for (const t of turns) {
        const list = bySession.get(t.sessionId) ?? [];
        list.push(t);
        bySession.set(t.sessionId, list);
      }
      for (const [sid, list] of bySession) {
        const uniq = uniqueInBatch(list);
        const h = list[0].harness;
        counts[h] = (counts[h] ?? 0) + (uniq.length - (baseline.get(sid) ?? 0));
      }
      this.writeMeta({ counts });
    } catch {
      // counts best-effort; docCount stays exact
    }
  }

  removeSession(sessionId: string): void {
    const schema = buildSchema();
    // Decrement counts from stored docs before deleting (session-scoped scan).
    try {
      this.index.reload();
      const searcher = this.index.searcher();
      const res = searcher.search(Query.termQuery(schema, "sessionId", sessionId), 100000);
      const counts = this.readCounts();
      for (const h of res.hits) {
        const hw = searcher.doc(h.docAddress).getFirst("harness");
        const name = typeof hw === "string" ? hw : "unknown";
        counts[name] = Math.max(0, (counts[name] ?? 1) - 1);
      }
      this.writeMeta({ counts });
    } catch {
      // counts best-effort; docCount stays exact
    }
    this.ensureWriter().deleteDocumentsByQuery(Query.termQuery(schema, "sessionId", sessionId));
    this.ensureWriter().commit();
    this.index.reload();
  }

  search(
    query: string,
    opts?: { harness?: string; projectId?: string; repo?: string; sessionId?: string; limit?: number },
  ): IndexSearchHit[] {
    if (!query.trim()) return [];
    const schema = buildSchema();
    const clauses: object[] = [];
    // Lenient parse: unknown operators become errors list instead of throwing.
    const [textQuery] = this.index.parseQueryLenient(query, ["content"]);
    clauses.push({ occur: Occur.Must, query: textQuery });
    if (opts?.harness) clauses.push({ occur: Occur.Must, query: Query.termQuery(schema, "harness", opts.harness) });
    if (opts?.projectId)
      clauses.push({ occur: Occur.Must, query: Query.termQuery(schema, "projectId", opts.projectId) });
    if (opts?.repo) clauses.push({ occur: Occur.Must, query: Query.termQuery(schema, "repo", opts.repo) });
    if (opts?.sessionId)
      clauses.push({ occur: Occur.Must, query: Query.termQuery(schema, "sessionId", opts.sessionId) });
    const combined = clauses.length === 1 ? textQuery : Query.booleanQuery(clauses);
    this.index.reload();
    const searcher = this.index.searcher();
    const res = searcher.search(combined, opts?.limit ?? 50);
    const hits: IndexSearchHit[] = [];
    for (const h of res.hits) {
      const doc = searcher.doc(h.docAddress);
      const turnId = doc.getFirst("id") as string;
      if (turnId) hits.push({ turnId, score: h.score ?? 0 });
    }
    return hits;
  }

  /** Fetch stored docs for packaging. */
  getTurnsByIds(ids: string[]): Turn[] {
    if (ids.length === 0) return [];
    const schema = buildSchema();
    this.index.reload();
    const searcher = this.index.searcher();
    const out: Turn[] = [];
    for (const id of ids) {
      const q = Query.termQuery(schema, "id", id);
      const res = searcher.search(q, 1);
      if (res.hits.length === 0) continue;
      const doc = searcher.doc(res.hits[0].docAddress);
      const num = (v: unknown) => (typeof v === "number" ? v : Number(v ?? 0));
      const str = (v: unknown) => (typeof v === "string" ? v : String(v ?? ""));
      const off = num(doc.getFirst("byteOffset"));
      out.push({
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
      });
    }
    return out;
  }

  stats(): IndexStats {
    this.index.reload();
    const searcher = this.index.searcher();
    const all = searcher.search(Query.allQuery(), 1_000_000);
    return {
      docCount: all.count ?? all.hits.length,
      lastSync: this.readMeta().lastSync,
      perHarness: this.readMeta().counts ?? {},
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

  private readCounts(): Record<string, number> {
    return this.readMeta().counts ?? {};
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
