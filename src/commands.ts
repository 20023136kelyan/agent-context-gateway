/**
 * Transport-agnostic command logic — CLI, HTTP and MCP all call these.
 * Nothing here touches stdout/sockets; returns plain data + throws Errors
 * with `not_found` / `bad_request` messages that transports map to codes.
 */
import { PARSE_VERSION } from "./adapters/types.js";
import { inProject } from "./core/project.js";
import { rerankDefaultOn } from "./search/reranker.js";
import { stat } from "node:fs/promises";
import { syncAllDetailed, rebuildAll, enrichTurns, searchableTurns, isRemoteSource } from "./indexing/sync.js";
import type { Session, Turn } from "./core/models.js";
import type { ContextAdapter } from "./adapters/types.js";
import { embedMissing, embedSessionTurns } from "./indexing/embed-sync.js";
import { embeddingsAvailable } from "./embeddings/provider.js";
import { loadRemotes, queryRemote } from "./remotes.js";
import { extractDecisions, type DecisionJudge } from "./decisions/extract.js";
import { buildOutcome, summarizeOutcome, type OutcomeSession, type SessionOutcome } from "./outcomes/outcome.js";
import { resolveJudge } from "./decisions/select.js";
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
import { recordUsage, defaultUsagePath, scoreBucket, termBucket } from "./observability/usage.js";

const HARNESSES = ["claude-code", "codex", "cursor", "zep", "git", "trajectory", "opencode"] as const;

function adapterFor(app: GatewayApp, harness: string) {
  if (!HARNESSES.includes(harness as (typeof HARNESSES)[number])) {
    throw new Error(`bad_request: unknown harness "${harness}"`);
  }
  const a = app.adapters.find((x) => x.harness === harness);
  if (!a) throw new Error(`not_found: no adapter for "${harness}"`);
  return a;
}

export async function ensureSynced(app: GatewayApp) {
  if (app.index.docCount() > 0) {
    // Built by an older parser (or before versions were recorded): rebuild
    // once, so an upgrade does not serve the old parse, or an empty action
    // index, until someone happens to run `sync`.
    if (app.cursors.parseVersion() !== PARSE_VERSION) await syncNow(app);
    return;
  }
  await app.indexLock.run(async () => {
    if (app.index.docCount() === 0) {
      const { indexed } = await syncAllDetailed(app.adapters, app.index, app.cursors);
      await recordActions(app, indexed);
      app.cursors.setParseVersion(PARSE_VERSION);
    }
  });
}

/**
 * Refresh the action index for the sessions a sync just
 * re-read. Called inside the index lock by every sync path, the watcher's
 * included, so it tracks the search index.
 */
export async function recordActions(app: GatewayApp, sessions: { adapter: ContextAdapter; session: Session }[]): Promise<void> {
  for (const { adapter, session } of sessions) {
    if (!adapter.listActions) continue;
    try {
      app.actions.replaceSession(session.harness, session.id, session.workspace, await adapter.listActions(session.id));
    } catch {
      // An unreadable session loses its actions until the next sync, not the sync.
    }
  }
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
      if (filter.project && !inProject(s, filter.project)) continue;
      if (filter.repo && s.repo !== filter.repo) continue;
      out.push(s);
    }
  }
  return out;
}

/** How a search's project scope was chosen; echoed in every search response. */
export interface ProjectScopeInfo {
  project: string | null;
  /** explicit = the caller named it; caller = the caller's own project; all = every project. */
  source: "explicit" | "caller" | "all";
}

/** Caller-supplied scoping, on top of SearchOptions. */
export interface ScopeOptions {
  /** The project the caller is working in (transports pass it: MCP/CLI from their cwd). */
  defaultProject?: string | null;
  /** Attach each result's session outcome summary (default true). */
  outcomes?: boolean;
}

const TOPOLOGY_SCOPES = new Set(["parent", "children", "siblings", "auto"]);

/**
 * Resolve the project a search runs in. An explicit `project` wins, and "*"
 * means every project. Otherwise search the caller's own project — measured
 * on real agent history, scoping took Jev-reranked NDCG@5 from 0.447 to 0.781
 * (14 queries; 0.324 -> 0.616 on 27), since an in-project ask ("is the app
 * finished?") is unanswerable across every project at once. The default only
 * applies when history exists for that project, so a first session in a new
 * one still finds something, and never to topology scopes, whose linked
 * sessions may span projects.
 */
export async function resolveProject(
  app: GatewayApp,
  opts: Pick<SearchOptions, "project" | "scope"> & ScopeOptions,
): Promise<ProjectScopeInfo> {
  if (opts.project === "*") return { project: null, source: "all" };
  if (opts.project) return { project: opts.project, source: "explicit" };
  if (opts.scope && TOPOLOGY_SCOPES.has(opts.scope)) return { project: null, source: "all" };
  if (opts.defaultProject && (await app.search.hasProject(opts.defaultProject))) {
    return { project: opts.defaultProject, source: "caller" };
  }
  return { project: null, source: "all" };
}

export async function searchOnce(app: GatewayApp, query: string, requested: SearchOptions & ScopeOptions = {}, chain: string[] = []) {
  if (!query.trim()) throw new Error("bad_request: empty query");
  await ensureSynced(app);
  const projectScope = await resolveProject(app, requested);
  const { defaultProject: _caller, outcomes: _outcomes, ...rest } = requested;
  const opts: SearchOptions = { ...rest, project: projectScope.project ?? undefined };
  if (!app.vectors && opts.semantic !== false) {
    try {
      await initVectors(app);
    } catch {
      // offline or no vectors yet — lexical-only
    }
  }
  const t0 = Date.now();
  const res = await app.search.search(query, opts);
  if (requested.outcomes !== false) await attachOutcomes(app, res.results, opts.asOf);
  try {
    // Shape-only telemetry (never query text, ids, or content).
    const nq = normalizeQuery(query);
    const terms = nq.indexQuery.split(" ").filter(Boolean).length;
    const counts: Record<string, number> = {};
    for (const r of res.results) {
      const h = r.provenance.harness;
      counts[h] = (counts[h] ?? 0) + 1;
    }
    recordUsage(defaultUsagePath(app.settings.stateDir), {
      kind: "search",
      ts: new Date().toISOString(),
      latencyMs: Date.now() - t0,
      semantic: opts.semantic !== false,
      rerank: opts.rerank === true,
      rawRank: opts.rawRank === true,
      engine: app.search.lastEngine ?? "lexical",
      reranker: app.reranker,
      harness: opts.harness ?? null,
      scope: res.scope,
      termBucket: termBucket(terms),
      hasEntities: nq.prNumbers.length > 0 || nq.fileRefs.length > 0,
      isWhy: isWhyQuery(query),
      results: res.results.length,
      resultHarnesses: counts,
      topScoreBucket: scoreBucket(res.results[0]?.score),
    });
  } catch {
    // Telemetry never breaks serving.
  }
  // P2e federation: fan out to configured remotes (read-only), merge by score.
  // Topological scopes stay local — remotes don't share our link registry.
  // Loop guard: skip remotes already in the chain (A->B->A); 2-hop max.
  const allRemotes = ["parent", "children", "siblings"].includes(res.scope) ? [] : loadRemotes();
  const remotes = chain.length >= 2 ? [] : allRemotes.filter((r) => !chain.includes(r.name));
  if (remotes.length === 0) return { ...res, projectScope };
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
    projectScope,
    results: merged.slice(0, maxResults),
    federation: {
      remotes: reports.map((r) => ({ name: r.name, ok: r.ok, results: r.results.length, error: r.error })),
    },
  };
}

/**
 * The outcome record of one session: what it set out to do, what it changed,
 * how it was checked and how it ended (outcomes/outcome.ts).
 */
export async function sessionOutcome(app: GatewayApp, harness: string, sessionId: string, opts: { asOf?: string } = {}): Promise<SessionOutcome> {
  if (opts.asOf && Number.isNaN(Date.parse(opts.asOf))) throw new Error(`bad_request: invalid asOf "${opts.asOf}" (want an ISO timestamp)`);
  await ensureSynced(app);
  const adapter = adapterFor(app, harness);
  const session = (await adapter.listSessions().catch(() => [] as Session[])).find((s) => s.id === sessionId);
  if (!session) throw new Error(`not_found: session "${sessionId}"`);
  return outcomeOf(app, adapter, session, opts.asOf);
}

async function outcomeOf(app: GatewayApp, adapter: ContextAdapter, session: OutcomeSession, asOf?: string): Promise<SessionOutcome> {
  const turns = await adapter.listTurns(session.id).catch(() => [] as Turn[]);
  const actions = app.actions.find({ sessionIds: [session.id], limit: 2000 }).filter((a) => a.harness === session.harness);
  return buildOutcome(session, turns, actions, { asOf });
}

/** Each local result gets its session's outcome summary (one record per session). */
async function attachOutcomes(app: GatewayApp, results: PackagedResult[], asOf?: string): Promise<void> {
  const bySession = new Map<string, Promise<SessionOutcome | null>>();
  for (const r of results) {
    if (r.via) continue;
    const { harness, sessionId } = r.provenance;
    const key = `${harness}:${sessionId}`;
    if (!bySession.has(key)) {
      const adapter = app.adapters.find((a) => a.harness === harness);
      bySession.set(key, adapter ? outcomeOf(app, adapter, { harness, id: sessionId }, asOf).catch(() => null) : Promise.resolve(null));
    }
    const o = await bySession.get(key)!;
    // Summarized by the task the hit falls in, found by the hit turn's position.
    const seq = r.context.find((t) => t.id === r.provenance.turnId)?.seq;
    if (o) r.outcome = summarizeOutcome(o, seq);
  }
}

export interface SessionPreview {
  harness: string;
  sessionId: string;
  project: string;
  startedAt: string;
  endedAt: string | null;
  /** Where the search matched, best first: open with get_context. */
  matches: { turnId: string; score: number; excerpt: string }[];
  /** How the session ended overall. */
  status: string;
  tasksTotal: number;
  /** Its tasks (request + how each went), the matched ones and their neighbours first. */
  tasks: { index: number; request: string; status: string; edits: number; matched: boolean }[];
}

/**
 * Candidate sessions for a query, each with its task list and outcomes, so
 * the calling agent can choose what to open instead of trusting one ranking.
 * LongMemEval-V2 (arXiv 2605.12493): a coding agent shortlisting from
 * trajectory-level metadata and previews reached 72.5% against 48.5% for
 * plain retrieval. The agent calling this is that agent.
 */
export async function browseSessions(
  app: GatewayApp,
  query: string,
  requested: SearchOptions & ScopeOptions & { maxSessions?: number; maxTasks?: number } = {},
): Promise<{ projectScope: ProjectScopeInfo; sessions: SessionPreview[] }> {
  const { maxSessions: ms, maxTasks: mt, ...rest } = requested;
  const maxSessions = Math.max(1, Math.min(ms ?? 8, 20));
  const maxTasks = Math.max(1, Math.min(mt ?? 12, 50));
  const res = await searchOnce(app, query, { ...rest, maxResults: Math.max(maxSessions * 2, 10), outcomes: false });
  const bySession = new Map<string, { harness: string; sessionId: string; hits: typeof res.results }>();
  for (const r of res.results) {
    if (r.via) continue;
    const key = `${r.provenance.harness}:${r.provenance.sessionId}`;
    const e = bySession.get(key) ?? { harness: r.provenance.harness, sessionId: r.provenance.sessionId, hits: [] };
    e.hits.push(r);
    bySession.set(key, e);
  }
  const sessions: SessionPreview[] = [];
  for (const { harness, sessionId, hits } of [...bySession.values()].slice(0, maxSessions)) {
    const adapter = app.adapters.find((a) => a.harness === harness);
    if (!adapter) continue;
    const session = (await adapter.listSessions().catch(() => [] as Session[])).find((s) => s.id === sessionId);
    const o = await outcomeOf(app, adapter, session ?? { harness: harness as Session["harness"], id: sessionId }, requested.asOf);
    const hitSeqs = hits.map((h) => h.context.find((t) => t.id === h.provenance.turnId)?.seq).filter((x): x is number => x !== undefined);
    const inTask = (i: number) => {
      const t = o.tasks[i]!;
      return hitSeqs.some((q) => q >= t.fromSeq && (t.toSeq === null || q < t.toSeq));
    };
    // Matched tasks first, then their neighbours, then the rest in order.
    const matched = o.tasks.map((_, i) => i).filter(inTask);
    const near = new Set(matched.flatMap((i) => [i - 1, i + 1]).filter((i) => i >= 0 && i < o.tasks.length && !matched.includes(i)));
    const order = [...matched, ...near, ...o.tasks.map((_, i) => i).filter((i) => !matched.includes(i) && !near.has(i))].slice(0, maxTasks).sort((a, b) => a - b);
    sessions.push({
      harness,
      sessionId,
      project: o.project,
      startedAt: o.startedAt,
      endedAt: o.endedAt,
      matches: hits.map((h) => ({ turnId: h.provenance.turnId, score: Number(h.score.toFixed(4)), excerpt: h.summary.replace(/\s+/g, " ").slice(0, 200) })),
      status: o.status,
      tasksTotal: o.tasks.length,
      tasks: order.map((i) => {
        const t = o.tasks[i]!;
        return { index: i + 1, request: (t.request?.text ?? "(work before any request)").slice(0, 160), status: t.status, edits: t.edits.count, matched: matched.includes(i) };
      }),
    });
  }
  return { projectScope: res.projectScope, sessions };
}

/**
 * Phase 3 decisions (spec §30-31): semantic search finds the discussion
 * region; heuristic extraction finds decision shape within. All derived
 * content carries method + confidence + source turns (never bare claims).
 */
export async function decideOnce(
  app: GatewayApp,
  query: string,
  requested: SearchOptions & ScopeOptions & { maxDecisions?: number; judge?: DecisionJudge } = {},
) {
  if (!query.trim()) throw new Error("bad_request: empty query");
  await ensureSynced(app);
  // Same project rule as search: decide can only weigh what retrieval finds.
  const projectScope = await resolveProject(app, requested);
  const { defaultProject: _caller, ...rest } = requested;
  const opts = { ...rest, project: projectScope.project ?? undefined };
  if (!app.vectors && opts.semantic !== false) {
    try {
      await initVectors(app);
    } catch {
      // lexical region retrieval still works
    }
  }
  const t0 = Date.now();
  // Region retrieval: find the discussion sessions the judge will then weigh.
  //
  // Reranking here was once hard-coded off to "prevent redundant passes", which
  // was sound while the judge WAS the cross-encoder. Reranker and judge are now
  // separate models, and this stage is the real bottleneck for `decide`: on the
  // fixture set, four of six why-queries fail before the judge sees anything,
  // returning no candidates or only a distractor. A judge cannot cite what
  // retrieval never found, so decide uses the same reranker-aware default as
  // search.
  const res = await app.search.search(query, {
    ...opts,
    maxResults: 6,
    rerank: opts.rerank ?? rerankDefaultOn(app.reranker),
  });
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
  // Injectable so the eval can vary the judge per arm: until now this was
  // hard-coded, which is why decisionCitations reads identically across every
  // mode. Production default is unchanged.
  const judge = opts.judge ?? resolveJudge();
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
    // Present only when a judge that distinguishes them has run. Callers use it
    // to tell a settled outcome from a proposal that merely looks like one.
    ...(d.decisionState ? { decisionState: d.decisionState } : {}),
    session: { harness: d.conclusion.harness, sessionId: d.sessionId },
    conclusion: { turnId: d.conclusion.id, timestamp: d.conclusion.timestamp, content: d.conclusion.content },
    rationale: d.rationale.map((t) => ({ turnId: t.id, timestamp: t.timestamp, content: t.content })),
    alternatives: d.alternatives.map((t) => ({ turnId: t.id, timestamp: t.timestamp, content: t.content })),
    question: d.question ? { turnId: d.question.id, content: d.question.content } : null,
  }));
  decisions.sort((a, b) => b.confidence - a.confidence);
  try {
    // Shape-only telemetry (never query text, ids, or content).
    recordUsage(defaultUsagePath(app.settings.stateDir), {
      kind: "decide",
      ts: new Date().toISOString(),
      latencyMs: Date.now() - t0,
      engine: app.search.lastEngine ?? "lexical",
      judge: judge.method,
      harness: opts.harness ?? null,
      candidates: candidatesToJudge.length,
      verdicts: decisions.length,
      topConfidenceBucket: scoreBucket(decisions[0]?.confidence),
    });
  } catch {
    // Telemetry never breaks serving.
  }
  return {
    query,
    whyRouted: isWhyQuery(query),
    projectScope,
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
    await recordActions(app, [{ adapter, session }]);
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
    // Context-only turns are never indexed; counting them would re-notify every sync.
    return known ? searchableTurns(turns).filter((t) => !known.has(t.id)) : [];
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
  let reparsed = false;
  const { result, fresh } = await app.indexLock.run(async () => {
    // A parser change (PARSE_VERSION) is invisible to incremental sync, which
    // skips unchanged files, and upserts leave behind docs whose ids moved.
    // Rebuild once, then record the version.
    const recorded = app.cursors.parseVersion();
    reparsed = !rebuild && recorded !== PARSE_VERSION && app.index.docCount() > 0;
    if (!rebuild && !reparsed) {
      const out = await syncAllDetailed(app.adapters, app.index, app.cursors, { detectNew: app.subscriptions.all().length > 0 });
      await recordActions(app, out.indexed);
      return { result: out.result, fresh: out.indexed.flatMap((s) => s.newTurns ?? []) };
    }
    const create =
      app.backend === "tantivy"
        ? () => new TantivyIndex(app.indexDir)
        : () => new SqliteIndex(app.indexDir);
    const out = await rebuildAll(app.adapters, create, app.cursors, app.indexDir, app.index);
    app.actions.clear();
    await recordActions(app, out.indexed);
    app.index = out.index;
    // Swap in place: a fresh SearchService would silently drop ACL, topology,
    // feedback and temporal attachments until restart.
    app.search.setIndex(out.index);
    // Everything is "new" to a rebuilt index: that's history, not news — no notifications.
    return { result: out.result, fresh: [] as Turn[] };
  });
  app.cursors.setParseVersion(PARSE_VERSION);
  if (result.sessionsIndexed > 0) app.search.invalidateSessions();
  await notifyNewTurns(app, fresh);
  // Semantic backfill is opt-in and resumable; lexical sync never blocks on it.
  let vectors: unknown = null;
  if (opts.embed) {
    const store = app.vectors ?? (await initVectors(app));
    vectors = await app.vectorLock.run(() => embedMissing(app.adapters, store));
  }
  return { ...result, reparsed, vectors };
}

/** One session's matching actions, newest first. */
export interface ActionFinding {
  harness: string;
  sessionId: string;
  last: string;
  actions: { kind: string; target: string; ts: string; turnId: string }[];
}

/**
 * Which sessions edited a file or ran a command: exact facts from tool calls
 * (actions/store.ts), not a ranking. Scoped like search: an explicit project,
 * "*" for every project, or the caller's own project when it has history.
 * Each action carries the turn to open with context.get_context.
 */
export async function findActions(
  app: GatewayApp,
  q: { file?: string; command?: string; since?: string; until?: string; maxSessions?: number } & Pick<SearchOptions, "project"> & ScopeOptions,
): Promise<{ projectScope: ProjectScopeInfo; sessions: ActionFinding[] }> {
  if (!q.file?.trim() && !q.command?.trim()) throw new Error("bad_request: pass a file or a command");
  if (q.since && Number.isNaN(Date.parse(q.since))) throw new Error(`bad_request: invalid since "${q.since}" (want an ISO timestamp)`);
  await ensureSynced(app);
  const projectScope = await resolveProject(app, q);
  const sessionIds = projectScope.project ? await app.search.projectSessionIds(projectScope.project) : undefined;
  const rows = app.actions.find({ file: q.file, command: q.command, since: q.since, until: q.until, sessionIds, limit: 2000 });
  const bySession = new Map<string, ActionFinding>();
  for (const r of rows) {
    const key = `${r.harness}:${r.sessionId}`;
    const entry = bySession.get(key) ?? { harness: r.harness, sessionId: r.sessionId, last: r.ts, actions: [] };
    if (entry.actions.length < 20) entry.actions.push({ kind: r.kind, target: r.target, ts: r.ts, turnId: r.turnId, ...(r.ok === undefined ? {} : { ok: r.ok }) });
    bySession.set(key, entry);
  }
  const maxSessions = Math.max(1, Math.min(q.maxSessions ?? 10, 50));
  return { projectScope, sessions: [...bySession.values()].slice(0, maxSessions) };
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
    // Which reranker a `rerank` request would use, and whether it is local.
    // Surfaced because a remote reranker sends query text and candidate
    // excerpts off-machine, and that should be inspectable, not implicit.
    reranking: {
      reranker: app.reranker,
      local: app.reranker !== "jev",
      /** Reranker-aware: on for Jev, off otherwise. An explicit
       *  `rerank` on the request overrides either way. */
      defaultOn: rerankDefaultOn(app.reranker),
    },
  };
}
