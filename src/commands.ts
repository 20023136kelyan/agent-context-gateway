/**
 * Transport-agnostic command logic — CLI, HTTP and MCP all call these.
 * Nothing here touches stdout/sockets; returns plain data + throws Errors
 * with `not_found` / `bad_request` messages that transports map to codes.
 */
import { stat } from "node:fs/promises";
import { syncAll, syncAllDetailed, rebuildAll, enrichTurns, isRemoteSource } from "./indexing/sync.js";
import type { Turn } from "./core/models.js";
import { embedMissing, embedSessionTurns } from "./indexing/embed-sync.js";
import { embeddingsAvailable } from "./embeddings/provider.js";
import { loadRemotes, queryRemote } from "./remotes.js";
import { extractDecisions, NeuralEntailmentJudge } from "./decisions/extract.js";
import { isWhyQuery } from "./decisions/cues.js";
import { normalizeQuery } from "./search/query.js";
import { relatedArtifacts, sessionsForArtifact, traverseArtifactGraphBFS } from "./artifacts/graph.js";
import { exploreLineage } from "./topology/lineage.js";
import { searchLiveSessions } from "./collaboration/live.js";
import { TantivyIndex } from "./indexing/tantivy-index.js";
import { SqliteIndex } from "./indexing/sqlite-index.js";
import type { PackagedResult } from "./search/search.js";
import { initVectors } from "./app.js";
import type { GatewayApp } from "./app.js";
import type { SearchOptions } from "./search/search.js";

const HARNESSES = ["claude-code", "codex", "cursor", "zep", "git"] as const;

function adapterFor(app: GatewayApp, harness: string) {
  if (!HARNESSES.includes(harness as (typeof HARNESSES)[number])) {
    throw new Error(`bad_request: unknown harness "${harness}"`);
  }
  const a = app.adapters.find((x) => x.harness === harness);
  if (!a) throw new Error(`not_found: no adapter for "${harness}"`);
  return a;
}

export async function ensureSynced(app: GatewayApp) {
  if (app.index.docCount() > 0) return;
  await app.indexLock.run(async () => {
    if (app.index.docCount() === 0) await syncAll(app.adapters, app.index, app.cursors);
  });
}

/** Evaluate subscriptions against turns that are new to the index; deliver webhooks. */
export async function notifyNewTurns(app: GatewayApp, turns: Turn[]): Promise<number> {
  if (turns.length === 0 || app.subscriptions.all().length === 0) return 0;
  const notifications = app.subscriptions.notifyTurns(turns);
  await app.subscriptions.deliver(notifications);
  return notifications.length;
}

export async function listSources(app: GatewayApp) {
  const out = [];
  for (const a of app.adapters) {
    const sessions = await a.listSessions().catch(() => []);
    out.push({ harness: a.harness, sessions: sessions.length });
  }
  return out;
}

export async function listSessions(app: GatewayApp, filter: { harness?: string; project?: string; repo?: string } = {}) {
  if (filter.harness) adapterFor(app, filter.harness);
  const out = [];
  for (const a of app.adapters) {
    if (filter.harness && a.harness !== filter.harness) continue;
    const sessions = await a.listSessions().catch(() => []);
    for (const s of sessions) {
      if (filter.project && s.projectId !== filter.project) continue;
      if (filter.repo && s.repo !== filter.repo) continue;
      out.push(s);
    }
  }
  return out;
}

export async function searchOnce(app: GatewayApp, query: string, opts: SearchOptions = {}, chain: string[] = []) {
  if (!query.trim()) throw new Error("bad_request: empty query");
  await ensureSynced(app);
  if (!app.vectors && opts.semantic !== false) {
    try {
      await initVectors(app);
    } catch {
      // offline or no vectors yet — lexical-only
    }
  }
  const res = await app.search.search(query, opts);
  // P2e federation: fan out to configured remotes (read-only), merge by score.
  // Topological scopes stay local — remotes don't share our link registry.
  // Loop guard: skip remotes already in the chain (A->B->A); 2-hop max.
  const allRemotes = ["parent", "children", "siblings"].includes(res.scope) ? [] : loadRemotes();
  const remotes = chain.length >= 2 ? [] : allRemotes.filter((r) => !chain.includes(r.name));
  if (remotes.length === 0) return res;
  const maxResults = opts.maxResults ?? 5;
  const reports = await Promise.all(
    remotes.map((r) =>
      queryRemote(r, { query, project: opts.project, repo: opts.repo, harness: opts.harness, maxResults }, 10000, chain),
    ),
  );
  const merged: PackagedResult[] = [...res.results];
  for (const rep of reports) {
    for (const raw of rep.results) {
      const cand = raw as Partial<PackagedResult>;
      if (!cand || typeof cand !== "object" || !cand.provenance) continue;
      merged.push({ ...(cand as PackagedResult), via: rep.name });
    }
  }
  merged.sort((a, b) => b.score - a.score);
  return {
    ...res,
    results: merged.slice(0, maxResults),
    federation: {
      remotes: reports.map((r) => ({ name: r.name, ok: r.ok, results: r.results.length, error: r.error })),
    },
  };
}

/**
 * Phase 3 decisions (spec §30-31): semantic search finds the discussion
 * region; heuristic extraction finds decision shape within. All derived
 * content carries method + confidence + source turns (never bare claims).
 */
export async function decideOnce(
  app: GatewayApp,
  query: string,
  opts: SearchOptions & { maxDecisions?: number } = {},
) {
  if (!query.trim()) throw new Error("bad_request: empty query");
  await ensureSynced(app);
  if (!app.vectors && opts.semantic !== false) {
    try {
      await initVectors(app);
    } catch {
      // lexical region retrieval still works
    }
  }
  // Region retrieval: find discussion sessions via fast RRF (skip 1st-stage rerank to prevent redundant passes)
  const res = await app.search.search(query, { ...opts, maxResults: 6, rerank: false });
  // Full turns of top sessions (ordered by best hit) for extraction.
  const seen = new Set<string>();
  const sessions: { harness: string; id: string }[] = [];
  for (const r of res.results) {
    const key = `${r.provenance.harness}:${r.provenance.sessionId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sessions.push({ harness: r.provenance.harness, id: r.provenance.sessionId });
    if (sessions.length >= 3) break;
  }
  const judge = new NeuralEntailmentJudge();
  // Query terms for the relevance gate (verdicts must answer THIS query).
  const queryTerms = normalizeQuery(query).indexQuery.split(" ").filter(Boolean);

  // Parallel fetch of candidate session turns
  const sessionTurnBatches = await Promise.all(
    sessions.map(async (s) => {
      const adapter = app.adapters.find((a) => a.harness === s.harness);
      if (!adapter) return { s, turns: [] };
      const turns = await adapter.listTurns(s.id).catch(() => []);
      return { s, turns };
    }),
  );

  const rawDecisions: (import("./decisions/extract.js").ExtractedDecision)[] = [];
  for (const { s, turns } of sessionTurnBatches) {
    if (turns.length === 0) continue;
    rawDecisions.push(...extractDecisions(s.id, turns, queryTerms));
  }

  // Pre-filter to top-6 candidate decisions by heuristic confidence before neural entailment
  rawDecisions.sort((a, b) => b.confidence - a.confidence);
  const candidatesToJudge = rawDecisions.slice(0, 6);

  const found = await judge.judge(candidatesToJudge, query);
  const decisions = found.map((d) => ({
    method: d.method,
    confidence: d.confidence,
    session: { harness: d.conclusion.harness, sessionId: d.sessionId },
    conclusion: { turnId: d.conclusion.id, timestamp: d.conclusion.timestamp, content: d.conclusion.content },
    rationale: d.rationale.map((t) => ({ turnId: t.id, timestamp: t.timestamp, content: t.content })),
    alternatives: d.alternatives.map((t) => ({ turnId: t.id, timestamp: t.timestamp, content: t.content })),
    question: d.question ? { turnId: d.question.id, content: d.question.content } : null,
  }));
  decisions.sort((a, b) => b.confidence - a.confidence);
  return {
    query,
    whyRouted: isWhyQuery(query),
    decisions: decisions.slice(0, opts.maxDecisions ?? 3),
    searchedAt: new Date().toISOString(),
  };
}

export async function getSession(app: GatewayApp, harness: string, sessionId: string) {
  const sessions = await listSessions(app, { harness });
  const found = sessions.find((s) => s.id === sessionId);
  if (!found) throw new Error(`not_found: session "${sessionId}"`);
  return found;
}

export async function getTurn(app: GatewayApp, harness: string, sessionId: string, turnId: string) {
  const a = adapterFor(app, harness);
  try {
    return await a.getTurn(sessionId, turnId);
  } catch {
    throw new Error(`not_found: turn "${turnId}"`);
  }
}

/** Expanded evidence window around a turn (direct retrieval, spec §44). */
export async function getContext(
  app: GatewayApp,
  harness: string,
  sessionId: string,
  turnId: string,
  window = 3,
) {
  const a = adapterFor(app, harness);
  const turns = await a.listTurns(sessionId).catch(() => {
    throw new Error(`not_found: session "${sessionId}"`);
  });
  const idx = turns.findIndex((t) => t.id === turnId);
  if (idx < 0) throw new Error(`not_found: turn "${turnId}"`);
  return turns.slice(Math.max(0, idx - window), idx + window + 1);
}

/** Precise single-session sync for hooks/watcher (fast: one file, no full scan). */
export async function syncSession(
  app: GatewayApp,
  harness: string,
  sessionId: string,
  opts: { embed?: boolean; parent?: string } = {},
) {
  const adapter = adapterFor(app, harness);
  const sessions = await adapter.listSessions().catch(() => []);
  const session = sessions.find((s) => s.id === sessionId);
  if (!session) throw new Error(`not_found: session "${sessionId}"`);
  const turns = await adapter.listTurns(session.id);
  const fresh = await app.indexLock.run(async () => {
    // New-turn detection costs an index lookup: only when someone subscribed.
    const known = app.subscriptions.all().length > 0 ? app.index.existingIds(turns.map((t) => t.id)) : null;
    app.index.indexTurns(enrichTurns(turns, session), session.sourcePath);
    // Stamp only a source this session owns alone: a shared source (Cursor DB,
    // Zep export, .git) still holds unsynced sessions the next full sync must see.
    const shared = sessions.some((s) => s !== session && s.sourcePath === session.sourcePath);
    if (!shared && !isRemoteSource(session.sourcePath)) {
      try {
        const st = await stat(session.sourcePath);
        app.cursors.set(session.sourcePath, { mtimeMs: st.mtimeMs, size: st.size });
        app.cursors.save();
      } catch {
        // source vanished mid-sync — index keeps the turns, next full sync reconciles
      }
    }
    app.index.markSynced();
    return known ? turns.filter((t) => !known.has(t.id)) : [];
  });
  app.search.invalidateSessions();
  await notifyNewTurns(app, fresh);
  let vectors: unknown = null;
  if (opts.embed) {
    const store = app.vectors ?? (await initVectors(app).catch(() => null));
    vectors = store
      ? await app.vectorLock.run(() => embedSessionTurns(adapter, session, store)).catch((e: unknown) => ({ error: String(e) }))
      : { error: "vector-store-unavailable" };
  }
  let link: unknown = null;
  if (opts.parent) {
    // Format "harness:sessionId" — declares lineage at sync time (hooks).
    const sep = opts.parent.indexOf(":");
    if (sep < 0) throw new Error('bad_request: --parent wants "harness:sessionId"');
    link = app.topology.link(
      { harness: opts.parent.slice(0, sep), sessionId: opts.parent.slice(sep + 1) },
      { harness, sessionId },
    );
  }
  return { session: sessionId, turns: turns.length, vectors, link };
}

export function linkSessions(app: GatewayApp, parentHarness: string, parentSession: string, childHarness: string, childSession: string) {  adapterFor(app, parentHarness);
  adapterFor(app, childHarness);
  return app.topology.link(
    { harness: parentHarness, sessionId: parentSession },
    { harness: childHarness, sessionId: childSession },
  );
}

export function unlinkSessions(app: GatewayApp, parentHarness: string, parentSession: string, childHarness: string, childSession: string) {
  return {
    removed: app.topology.unlink(
      { harness: parentHarness, sessionId: parentSession },
      { harness: childHarness, sessionId: childSession },
    ),
  };
}

export function showTopology(app: GatewayApp, filter: { harness?: string; sessionId?: string } = {}) {
  const all = app.topology.all();
  if (filter.sessionId) {
    const ref = { harness: filter.harness ?? "", sessionId: filter.sessionId };
    return filter.harness ? app.topology.touching(ref) : all.filter((l) => l.parent.sessionId === filter.sessionId || l.child.sessionId === filter.sessionId);
  }
  return all;
}

/** Record helpful/not feedback for a turn (affects future ranking). */
export function recordFeedback(app: GatewayApp, turnId: string, helpful: boolean, note?: string) {
  const parsed = turnId.split(":");
  if (parsed.length < 3) throw new Error(`bad_request: malformed turnId "${turnId}"`);
  return app.feedback.record(turnId, helpful, note);
}

/** Artifacts related to the given one via session co-occurrence (P3 graph). */
export async function getRelated(app: GatewayApp, artifact: string, limit = 10) {
  if (!artifact.trim()) throw new Error("bad_request: empty artifact");
  await ensureSynced(app);
  return { artifact, ...relatedArtifacts(app.index, artifact, limit) };
}

/** Multi-hop BFS traversal over the artifact graph (e.g. file -> session -> PR -> session -> file). */
export async function traverseArtifacts(app: GatewayApp, artifact: string, maxDepth = 2) {
  if (!artifact.trim()) throw new Error("bad_request: empty artifact");
  await ensureSynced(app);
  return traverseArtifactGraphBFS(app.index, artifact, maxDepth);
}

/** Bi-temporal invalidations list (Phase C.1). */
export function listInvalidations(app: GatewayApp) {
  return app.temporal.all();
}

/** Record a derived or observed invalidation between turns. */
export function recordInvalidation(
  app: GatewayApp,
  supersededTurnId: string,
  supersedingTurnId: string,
  reason: string,
  supersededAt: string,
  sourceSessionId: string,
) {
  return app.temporal.recordInvalidation({
    supersededTurnId,
    supersedingTurnId,
    reason,
    supersededAt,
    sourceSessionId,
  });
}

/** ACL rule management (Phase C.2). */
export function listAclRules(app: GatewayApp) {
  return app.acl.all();
}

export function setAclRule(app: GatewayApp, rule: import("./security/acl.js").AccessRule) {
  app.acl.setRule(rule);
  return rule;
}

export function removeAclRule(app: GatewayApp, principal: string) {
  return { removed: app.acl.removeRule(principal) };
}

/** Search active/running sessions directly from native history (spec §67). */
export async function searchLive(
  app: GatewayApp,
  query: string,
  opts?: { activeWindowMs?: number; maxTurnsPerSession?: number },
) {
  if (!query.trim()) throw new Error("bad_request: empty query");
  return searchLiveSessions(app.adapters, query, opts);
}

/** Full ancestry tree, descendants, and siblings explorer (spec §65). */
export function getLineage(app: GatewayApp, harness: string, sessionId: string) {
  adapterFor(app, harness);
  return exploreLineage(app.topology, { harness, sessionId });
}

/** Context subscriptions management (spec §66). */
export function listSubscriptions(app: GatewayApp) {
  return app.subscriptions.all();
}

export function createSubscription(
  app: GatewayApp,
  query: string,
  opts?: { harness?: string; webhookUrl?: string },
) {
  if (!query.trim()) throw new Error("bad_request: empty query");
  return app.subscriptions.subscribe(query, opts);
}

export function cancelSubscription(app: GatewayApp, id: string) {
  return { removed: app.subscriptions.unsubscribe(id) };
}

export async function syncNow(app: GatewayApp, rebuild = false, opts: { embed?: boolean } = {}) {
  const { result, fresh } = await app.indexLock.run(async () => {
    if (!rebuild) {
      const out = await syncAllDetailed(app.adapters, app.index, app.cursors, { detectNew: app.subscriptions.all().length > 0 });
      return { result: out.result, fresh: out.indexed.flatMap((s) => s.newTurns ?? []) };
    }
    const create =
      app.backend === "tantivy"
        ? () => new TantivyIndex(app.indexDir)
        : () => new SqliteIndex(app.indexDir);
    const out = await rebuildAll(app.adapters, create, app.cursors, app.indexDir, app.index);
    app.index = out.index;
    // Swap in place: a fresh SearchService would silently drop ACL, topology,
    // feedback and temporal attachments until restart.
    app.search.setIndex(out.index);
    // Everything is "new" to a rebuilt index: that's history, not news — no notifications.
    return { result: out.result, fresh: [] as Turn[] };
  });
  if (result.sessionsIndexed > 0) app.search.invalidateSessions();
  await notifyNewTurns(app, fresh);
  // Semantic backfill is opt-in and resumable; lexical sync never blocks on it.
  let vectors: unknown = null;
  if (opts.embed) {
    const store = app.vectors ?? (await initVectors(app));
    vectors = await app.vectorLock.run(() => embedMissing(app.adapters, store));
  }
  return { ...result, vectors };
}

/** Explicit background embedding backfill across historical sessions. */
export async function backfillEmbeddings(
  app: GatewayApp,
  opts?: {
    batchSize?: number;
    maxSessions?: number;
    onProgress?: (p: {
      sessionsScanned: number;
      totalSessions: number;
      turnsEmbedded: number;
      turnsSkipped: number;
      currentSessionId?: string;
    }) => void;
  },
) {
  const store = app.vectors ?? (await initVectors(app));
  return app.vectorLock.run(() => embedMissing(app.adapters, store, opts));
}

export async function health(app: GatewayApp) {
  const stats = app.index.stats();
  const sources = await listSources(app);
  const embStatus = await embeddingsAvailable();
  const vectorCount = app.vectors ? await app.vectors.count().catch(() => null) : null;
  const backfillPercent =
    vectorCount !== null && stats.docCount > 0
      ? Math.min(100, Number(((vectorCount / stats.docCount) * 100).toFixed(1)))
      : 0;

  return {
    ok: true,
    backend: app.backend,
    docCount: stats.docCount,
    perHarness: stats.perHarness,
    lastSync: stats.lastSync ?? null,
    sources,
    semantic: {
      available: embStatus.available,
      engine: embStatus.engine,
      vectors: vectorCount,
      backfillPercent,
    },
  };
}
