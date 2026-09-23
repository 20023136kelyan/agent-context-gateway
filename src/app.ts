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
import { TrajectoryAdapter, defaultTrajectoryDir } from "./adapters/trajectories.js";
import { OpenCodeAdapter } from "./adapters/opencode.js";
import { GitAdapter } from "./adapters/git.js";
import { CombinedAdapter } from "./adapters/combined.js";
import { cursorStores, savedRoots, type HistoryKind } from "./adapters/locations.js";
import type { SearchIndex } from "./indexing/types.js";
import { TantivyIndex } from "./indexing/tantivy-index.js";
import { SqliteIndex } from "./indexing/sqlite-index.js";
import type { VectorBackend } from "./indexing/vectors.js";
import { openVectorStore, type VectorBackendName } from "./indexing/vector-backend.js";
import { resolveReranker, makeReranker, type RerankerName } from "./search/reranker.js";
import { resolveSettings, type GatewaySettings } from "./settings.js";
import { CursorStore } from "./indexing/store.js";
import { TopologyStore, defaultTopologyPath } from "./topology/store.js";
import { FeedbackStore, defaultFeedbackPath } from "./feedback/store.js";
import { TemporalStore, defaultTemporalPath } from "./temporal/bi-temporal.js";
import { AclStore, defaultAclPath } from "./security/acl.js";
import { SubscriptionStore, defaultSubscriptionsPath } from "./collaboration/live.js";
import { SearchService } from "./search/search.js";
import { ActionStore, defaultActionsPath } from "./actions/store.js";

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
  /** Base for every derived-state store. Defaults to CONTEXT_GATEWAY_STATE or ~/.context-gateway. */
  stateDir?: string;
  indexDir?: string;
  vectorDir?: string;
  claudeDir?: string;
  codexDir?: string;
  cursorDb?: string;
  zepDir?: string;
  trajectoryDir?: string;
  opencodeDb?: string;
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
  vectors: VectorBackend | null;
  /** Which backend served the vectors, once opened. */
  vectorBackend: VectorBackendName | null;
  /** Which reranker is installed. Runs when a request reranks, explicitly or by default. */
  reranker: RerankerName;
  /** Resolved configuration. Reaches every transport, since all take `app`. */
  readonly settings: GatewaySettings;
  vectorDir: string;
  topology: TopologyStore;
  feedback: FeedbackStore;
  temporal: TemporalStore;
  acl: AclStore;
  subscriptions: SubscriptionStore;
  /** What agents did (files edited, commands run), refreshed by every sync path. */
  actions: ActionStore;
  /** Serializes index + cursor writes (watcher, POST /sync, rebuild, syncSession, git events). Never nest. */
  indexLock: AsyncLock;
  /** Serializes vector-store writes, separately so long backfills don't block lexical sync. */
  vectorLock: AsyncLock;
}

/** The adapter that reads one history location (see adapters/locations.ts for what each names). */
export function adapterAt(kind: HistoryKind, path: string): ContextAdapter {
  switch (kind) {
    case "claude-code":
      return new ClaudeAdapter(path);
    case "codex":
      return new CodexAdapter(path);
    case "opencode":
      return new OpenCodeAdapter(path);
    case "cursor": {
      const { globalDb, workspaceRoot } = cursorStores(path);
      return new CursorAdapter(globalDb, workspaceRoot);
    }
    case "trajectory":
      return new TrajectoryAdapter(path);
  }
}

export function createApp(opts: AppOptions = {}): GatewayApp {
  const settings = resolveSettings(opts);
  const { backend, indexDir, stateDir } = settings;
  // Previously `${HOME}/.context-gateway/vectors-lance`, which ignored
  // CONTEXT_GATEWAY_STATE — so setting a state dir relocated six stores but left
  // the vectors behind. Now it hangs off stateDir like everything else.
  const vectorDir = settings.vectorDir;
  // Locations saved with `acg paths` (in this app's own settings.json) replace a
  // harness's default; an explicit option here still wins over both.
  const saved = (kind: HistoryKind, fallback: () => ContextAdapter): ContextAdapter => {
    const paths = savedRoots(kind, { ...process.env, CONTEXT_GATEWAY_STATE: stateDir });
    if (!paths) return fallback();
    const parts = paths.map((p) => adapterAt(kind, p));
    return parts.length === 1 ? parts[0]! : new CombinedAdapter(kind, parts);
  };
  const adapters: ContextAdapter[] = [
    opts.claudeDir ? new ClaudeAdapter(opts.claudeDir) : saved("claude-code", () => new ClaudeAdapter()),
    opts.codexDir ? new CodexAdapter(opts.codexDir) : saved("codex", () => new CodexAdapter()),
    opts.cursorDb ? new CursorAdapter(opts.cursorDb) : saved("cursor", () => new CursorAdapter()),
    opts.zepDir ? new ZepAdapter({ localDir: opts.zepDir }) : new ZepAdapter(),
    opts.trajectoryDir ? new TrajectoryAdapter(opts.trajectoryDir) : saved("trajectory", () => new TrajectoryAdapter(defaultTrajectoryDir())),
    opts.opencodeDb ? new OpenCodeAdapter(opts.opencodeDb) : saved("opencode", () => new OpenCodeAdapter()),
    new GitAdapter(opts.gitRepos ?? []),
  ];
  const index: SearchIndex =
    backend === "tantivy" ? new TantivyIndex(indexDir) : new SqliteIndex(indexDir);
  const cursors = new CursorStore(indexDir);
  const topology = new TopologyStore(defaultTopologyPath(stateDir));
  const feedback = new FeedbackStore(defaultFeedbackPath(stateDir));
  const temporal = new TemporalStore(defaultTemporalPath(stateDir));
  const acl = new AclStore(defaultAclPath(stateDir));
  const subscriptions = new SubscriptionStore(defaultSubscriptionsPath(stateDir));
  const actions = new ActionStore(defaultActionsPath(stateDir));
  const search = new SearchService(adapters, index);
  search.attachTopology(topology);
  search.attachFeedback(feedback);
  search.attachTemporal(temporal);
  search.attachAcl(acl);
  // Installed once. Whether a request uses it is decided per request: an
  // explicit `rerank` wins, otherwise `rerankDefaultOn` — ON for jev, so a
  // TYPESAFE_API_KEY alone sends query text to Jev on every search.
  const { name: reranker, reranker: rerankerImpl } = settings.reranker
    ? { name: settings.reranker, reranker: makeReranker(settings.reranker) }
    : resolveReranker();
  search.setReranker(rerankerImpl);
  return {
    adapters, index, cursors, search, indexDir, backend, vectors: null, vectorBackend: null, reranker, settings, vectorDir, topology, feedback, temporal, acl, subscriptions, actions,
    indexLock: new AsyncLock(),
    vectorLock: new AsyncLock(),
  };
}

/** Open (or create) the vector store and attach it to search. Safe to skip offline. */
export async function initVectors(app: GatewayApp, dir = app.vectorDir): Promise<VectorBackend> {
  const { mkdirSync } = await import("node:fs");
  mkdirSync(dir, { recursive: true });
  const { store, backend } = await openVectorStore(dir);
  app.vectors = store;
  app.vectorBackend = backend;
  app.search.attachVectors(store);
  return store;
}

export function closeApp(app: GatewayApp): void {
  try {
    app.index.close();
  } catch {
    // best-effort
  }
  app.actions?.close();
}
