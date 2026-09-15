/**
 * Shared app factory. Readers share freely (Tantivy searchers take no lock);
 * only WRITERS contend (single writer per index dir). CLI delegates writes to
 * a live serve; direct writers get a clear "index busy" error to surface.
 */
import type { ContextAdapter } from "./adapters/types.js";
import { ClaudeAdapter } from "./adapters/claude.js";
import { CodexAdapter } from "./adapters/codex.js";
import { CursorAdapter } from "./adapters/cursor.js";
import { ZepAdapter } from "./adapters/zep.js";
import { GitAdapter } from "./adapters/git.js";
import type { SearchIndex } from "./indexing/types.js";
import { TantivyIndex, defaultIndexDir as tantivyDir } from "./indexing/tantivy-index.js";
import { SqliteIndex, defaultIndexDir as sqliteDir } from "./indexing/sqlite-index.js";
import { VectorStore } from "./indexing/vectors.js";
import { CursorStore } from "./indexing/store.js";
import { TopologyStore, defaultTopologyPath } from "./topology/store.js";
import { FeedbackStore, defaultFeedbackPath } from "./feedback/store.js";
import { TemporalStore, defaultTemporalPath } from "./temporal/bi-temporal.js";
import { AclStore, defaultAclPath } from "./security/acl.js";
import { SubscriptionStore, defaultSubscriptionsPath } from "./collaboration/live.js";
import { SearchService } from "./search/search.js";

/** Promise-chain mutex: runs callbacks one at a time, in call order. */
export class AsyncLock {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T> | T): Promise<T> {
    const result = this.tail.then(fn);
    this.tail = result.catch(() => undefined);
    return result;
  }
}

export interface AppOptions {
  indexDir?: string;
  vectorDir?: string;
  claudeDir?: string;
  codexDir?: string;
  cursorDb?: string;
  zepDir?: string;
  gitRepos?: string[];
  backend?: "tantivy" | "sqlite";
}

export interface GatewayApp {
  adapters: ContextAdapter[];
  index: SearchIndex;
  cursors: CursorStore;
  search: SearchService;
  indexDir: string;
  backend: "tantivy" | "sqlite";
  /** Attached semantic backend (null until initVectors). */
  vectors: VectorStore | null;
  vectorDir: string;
  topology: TopologyStore;
  feedback: FeedbackStore;
  temporal: TemporalStore;
  acl: AclStore;
  subscriptions: SubscriptionStore;
  /** Serializes index + cursor writes (watcher, POST /sync, rebuild, syncSession, git events). Never nest. */
  indexLock: AsyncLock;
  /** Serializes vector-store writes, separately so long backfills don't block lexical sync. */
  vectorLock: AsyncLock;
}

export function createApp(opts: AppOptions = {}): GatewayApp {
  const backend = opts.backend ?? "tantivy";
  const indexDir = opts.indexDir ?? (backend === "tantivy" ? tantivyDir() : sqliteDir());
  const home = process.env.HOME ?? "/tmp";
  const vectorDir = opts.vectorDir ?? `${home}/.context-gateway/vectors-lance`;
  const adapters: ContextAdapter[] = [
    opts.claudeDir ? new ClaudeAdapter(opts.claudeDir) : new ClaudeAdapter(),
    opts.codexDir ? new CodexAdapter(opts.codexDir) : new CodexAdapter(),
    opts.cursorDb ? new CursorAdapter(opts.cursorDb) : new CursorAdapter(),
    opts.zepDir ? new ZepAdapter({ localDir: opts.zepDir }) : new ZepAdapter(),
    new GitAdapter(opts.gitRepos ?? []),
  ];
  const index: SearchIndex =
    backend === "tantivy" ? new TantivyIndex(indexDir) : new SqliteIndex(indexDir);
  const cursors = new CursorStore(indexDir);
  const topology = new TopologyStore(defaultTopologyPath(process.env.CONTEXT_GATEWAY_STATE));
  const feedback = new FeedbackStore(defaultFeedbackPath(process.env.CONTEXT_GATEWAY_STATE));
  const temporal = new TemporalStore(defaultTemporalPath(process.env.CONTEXT_GATEWAY_STATE));
  const acl = new AclStore(defaultAclPath(process.env.CONTEXT_GATEWAY_STATE));
  const subscriptions = new SubscriptionStore(defaultSubscriptionsPath(process.env.CONTEXT_GATEWAY_STATE));
  const search = new SearchService(adapters, index);
  search.attachTopology(topology);
  search.attachFeedback(feedback);
  search.attachTemporal(temporal);
  search.attachAcl(acl);
  return {
    adapters, index, cursors, search, indexDir, backend, vectors: null, vectorDir, topology, feedback, temporal, acl, subscriptions,
    indexLock: new AsyncLock(),
    vectorLock: new AsyncLock(),
  };
}

/** Open (or create) the vector store and attach it to search. Safe to skip offline. */
export async function initVectors(app: GatewayApp, dir = app.vectorDir): Promise<VectorStore> {
  const { mkdirSync } = await import("node:fs");
  mkdirSync(dir, { recursive: true });
  const store = await VectorStore.open(dir);
  app.vectors = store;
  app.search.attachVectors(store);
  return store;
}

export function closeApp(app: GatewayApp): void {
  try {
    app.index.close();
  } catch {
    // best-effort
  }
}
