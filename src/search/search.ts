/**
 * M3 search orchestrator: index (candidate retrieval) -> adapters (truth)
 * -> rank -> expand -> package with provenance.
 *
 * Index hits are candidates only. All returned content comes from adapters
 * reading native histories, so packaging never serves stale index text.
 */
import type { ContextAdapter } from "../adapters/types.js";
import type { Provenance, Session, Turn, Harness } from "../core/models.js";
import type { SearchIndex, IndexSearchHit } from "../indexing/types.js";
import type { VectorStore } from "../indexing/vectors.js";
import type { TopologyStore } from "../topology/store.js";
import type { FeedbackStore } from "../feedback/store.js";
import { routeAutoScope } from "../topology/store.js";
import { embedQuery } from "../embeddings/provider.js";
import { parseTurnId } from "../core/id.js";
import { normalizeQuery, type NormalizedQuery } from "./query.js";
import { finalScore, rrfBaseScore } from "./rank.js";
import { extractArtifacts } from "../adapters/text.js";
import { rewriteConversationalQuery, type RewrittenQuery } from "./rewriter.js";
import { getSharedReranker, CrossEncoderReranker } from "./rerank.js";
import type { TemporalStore, InvalidationRecord } from "../temporal/bi-temporal.js";
import type { AclStore } from "../security/acl.js";

export interface SearchOptions {
  project?: string;
  /** Git repo root filter (precise project identity, spec §28). */
  repo?: string;
  harness?: Harness;
  sessionId?: string;
  /** project (default) | parent | children | siblings | auto */
  scope?: string;
  /** Required for parent/children/siblings/auto-with-hint scopes. */
  callerSessionId?: string;
  /** Caller identity for resource-level ACL enforcement (Phase C.2) */
  callerPrincipal?: string;
  /** Neural Cross-Encoder reranker over top candidates (Phase B.2) */
  rerank?: boolean;
  /** Use vector candidates when a store is attached (default true); false = lexical only. */
  semantic?: boolean;
  /** Point-in-time reconstruction (ISO timestamp): ignores invalidations after this time (Phase C.1) */
  asOf?: string;
  /** Include superseded historical knowledge without demotion */
  includeSuperseded?: boolean;
  maxResults?: number;
  maxTurns?: number;
  maxTokens?: number;
}

export interface PackagedResult {
  score: number;
  /** Extractive: first lines of center turn, never generated. */
  summary: string;
  provenance: Provenance;
  context: Turn[];
  artifacts: string[];
  /** Remote gateway that served this result (absent = local). */
  via?: string;
  /** Bi-temporal invalidation record if this turn was superseded */
  invalidation?: InvalidationRecord;
  isSuperseded?: boolean;
}

export interface FederationReport {
  remotes: { name: string; ok: boolean; results: number; error?: string }[];
}

export interface SearchResponse {
  query: NormalizedQuery;
  /** Requested scope, or the auto-routed one. */
  scope: string;
  results: PackagedResult[];
  federation?: FederationReport;
  searchedAt: string;
}

const TOPO_SCOPES = new Set(["parent", "children", "siblings", "auto"]);
/** Candidates the cross-encoder scores when rerank is on. */
const RERANK_POOL = 15;

export class SearchService {
  private vectors: VectorStore | null = null;
  private topology: TopologyStore | null = null;
  private feedback: FeedbackStore | null = null;
  private temporal: TemporalStore | null = null;
  private acl: AclStore | null = null;
  private reranker: Pick<CrossEncoderReranker, "rerank"> = getSharedReranker();

  constructor(
    private adapters: ContextAdapter[],
    private index: SearchIndex,
  ) {}

  /** Attach semantic backend (optional; search degrades to lexical without it). */
  attachVectors(store: VectorStore): void {
    this.vectors = store;
  }

  attachTopology(store: TopologyStore): void {
    this.topology = store;
  }

  attachFeedback(store: FeedbackStore): void {
    this.feedback = store;
  }

  attachTemporal(store: TemporalStore): void {
    this.temporal = store;
  }

  attachAcl(store: AclStore): void {
    this.acl = store;
  }

  /** Swap in a rebuilt index, keeping every attachment (ACL, topology, feedback, temporal, vectors). */
  setIndex(index: SearchIndex): void {
    this.index = index;
  }

  /** Replace the cross-encoder (tests; alternative rerankers). */
  setReranker(reranker: Pick<CrossEncoderReranker, "rerank">): void {
    this.reranker = reranker;
  }

  private adapterFor(harness: string): ContextAdapter | undefined {
    return this.adapters.find((a) => a.harness === harness);
  }

  async search(rawQuery: string, opts: SearchOptions = {}): Promise<SearchResponse> {
    const scope = opts.scope ?? "project";
    if (!["project", "parent", "children", "siblings", "auto"].includes(scope)) {
      throw new Error(`bad_request: unknown scope "${scope}" (want project|parent|children|siblings|auto)`);
    }
    const maxResults = opts.maxResults ?? 5;
    const maxTurns = opts.maxTurns ?? 7;
    const maxTokens = opts.maxTokens ?? 2000;
    const half = Math.floor(maxTurns / 2);
    const nowMs = Date.now();

    // Session map for project/agent/sourcePath (adapter-cached, ~ms warm).
    const sessions = new Map<string, Session>();
    for (const a of this.adapters) {
      for (const s of await a.listSessions().catch(() => [])) sessions.set(`${a.harness}:${s.id}`, s);
    }
    // The caller's harness comes from its own session, not from the result filter.
    const callerSession = opts.callerSessionId
      ? [...sessions.values()].find((s) => s.id === opts.callerSessionId)
      : undefined;

    // CAsT conversational rewriting: resolve topology references, strip filler, generate multi-query variants
    const rewritten = rewriteConversationalQuery(rawQuery, opts.callerSessionId, this.topology, callerSession?.harness);
    const nq = normalizeQuery(rewritten.primaryQuery);
    const limit = Math.max(50, maxResults * 10);

    // Topological scope resolution (explicit links; auto routes from wording).
    let scopeSessions: { harness: string; sessionId: string }[] | null = null;
    let effectiveScope = scope;
    if (rewritten.resolvedTarget) {
      scopeSessions = [rewritten.resolvedTarget];
      effectiveScope = rewritten.resolvedRelation ?? "parent";
    } else if (TOPO_SCOPES.has(scope)) {
      let routed: string | null = scope;
      if (scope === "auto") {
        routed = routeAutoScope(rawQuery);
        if (!routed) effectiveScope = "project";
      }
      if (routed && routed !== "auto") {
        effectiveScope = routed;
        if (!opts.callerSessionId) {
          throw new Error(`bad_request: scope="${routed}" needs callerSessionId (--as-session)`);
        }
        const caller = callerSession;
        if (!caller) throw new Error(`not_found: caller session "${opts.callerSessionId}"`);
        const ref = { harness: caller.harness, sessionId: caller.id };
        const topo = this.topology;
        scopeSessions =
          routed === "parent" ? (topo?.parentsOf(ref) ?? [])
          : routed === "children" ? (topo?.childrenOf(ref) ?? [])
          : (topo?.siblingsOf(ref) ?? []);
      }
    }

    const baseFilters = { harness: opts.harness, projectId: opts.project, repo: opts.repo };
    const hits: IndexSearchHit[] = [];
    const lexRanks = new Map<string, number>();
    const pushHits = (hs: IndexSearchHit[]) => {
      for (const h of hs) {
        if (!hits.some((x) => x.turnId === h.turnId)) {
          hits.push(h);
          lexRanks.set(h.turnId, hits.length); // 1-indexed rank
        }
      }
    };
    if (scopeSessions) {
      // Fan out per linked session (usually a handful).
      const per = Math.max(10, Math.ceil(limit / Math.max(1, scopeSessions.length)));
      for (const target of scopeSessions) {
        if (opts.harness && target.harness !== opts.harness) continue;
        pushHits(this.index.search(nq.indexQuery, { ...baseFilters, sessionId: target.sessionId, limit: per }));
      }
    } else {
      pushHits(this.index.search(nq.indexQuery, { ...baseFilters, sessionId: opts.sessionId, limit }));
      // Multi-query variant retrieval: broaden candidate elicitation (SIGIR '24)
      for (const variant of rewritten.variants) {
        const vNq = normalizeQuery(variant);
        if (vNq.indexQuery && vNq.indexQuery !== nq.indexQuery) {
          pushHits(this.index.search(vNq.indexQuery, { ...baseFilters, sessionId: opts.sessionId, limit: Math.floor(limit / 2) }));
        }
      }
    }

    // Semantic candidates (best-effort; any failure -> lexical-only).
    // Minimum similarity gate: KNN always returns top-K even for unrelated
    // queries. Only hits with genuine semantic affinity (>=0.45) enter RRF,
    // preventing spurious vector hits from polluting lexical-only domains.
    const MIN_VECTOR_SIM = 0.45;
    const vecRanks = new Map<string, number>();
    const vecSim = new Map<string, number>();
    let hasVectors = false;
    if (opts.semantic !== false && this.vectors && (await this.vectors.count().catch(() => 0)) > 0) {
      try {
        const qv = await embedQuery(nq.indexQuery);
        let vhits: { turnId: string; similarity: number }[] = [];
        if (scopeSessions) {
          const per = Math.max(10, Math.ceil(limit / Math.max(1, scopeSessions.length)));
          for (const target of scopeSessions) {
            if (opts.harness && target.harness !== opts.harness) continue;
            const res = await this.vectors.nearest(qv, per, { ...baseFilters, sessionId: target.sessionId });
            vhits.push(...res);
          }
          vhits.sort((a, b) => b.similarity - a.similarity);
        } else {
          vhits = await this.vectors.nearest(qv, limit, { ...baseFilters, sessionId: opts.sessionId });
        }
        // Filter out low-similarity noise
        const qualified = vhits.filter((h) => h.similarity >= MIN_VECTOR_SIM);
        if (qualified.length > 0) {
          hasVectors = true;
          qualified.forEach((h, idx) => {
            if (!vecRanks.has(h.turnId)) {
              vecRanks.set(h.turnId, idx + 1); // 1-indexed rank
              vecSim.set(h.turnId, h.similarity);
            }
            if (!hits.some((x) => x.turnId === h.turnId)) hits.push({ turnId: h.turnId, score: 0 });
          });
        }
      } catch {
        // embedding backend down — lexical results stand alone
      }
    }

    // Group hits per session, resolve turns from native truth.
    // Two-phase for latency: rank ALL candidates from stored index docs
    // (ms), then full-parse ONLY top sessions for expansion/packaging.
    // Stored docs may be stale — hits missing from truth are dropped.
    const now = new Date().toISOString();
    const storedById = new Map(this.index.getTurnsByIds(hits.map((h) => h.turnId)).map((t) => [t.id, t]));
    const ranked: { hit: (typeof hits)[number]; turn: Turn; session: Session; score: number }[] = [];
    for (const hit of hits) {
      const parsed = parseTurnId(hit.turnId);
      if (!parsed) continue;
      if (opts.harness && parsed.harness !== opts.harness) continue;
      const session = sessions.get(`${parsed.harness}:${parsed.sessionId}`);
      if (!session) continue;
      if (opts.project && session.projectId !== opts.project) continue;
      if (opts.repo && session.repo !== opts.repo) continue;
      // Resource-level ACL enforcement: zero unauthorized candidate leakage (IEEE 2025)
      if (this.acl && !this.acl.canAccess(opts.callerPrincipal, session)) continue;
      const stored = storedById.get(hit.turnId);
      if (!stored) continue;

      // Temporal post-filters.
      if (nq.after && stored.timestamp < nq.after) continue;
      if (nq.before && stored.timestamp > nq.before) continue;

      // Reciprocal Rank Fusion of sparse lexical + dense vector ranks
      const lexRank = lexRanks.get(hit.turnId) ?? 0;
      const vecRank = vecRanks.get(hit.turnId) ?? 0;
      const rrf = rrfBaseScore(lexRank, vecRank, vecSim.get(hit.turnId));

      let score = finalScore(
        rrf,
        opts.project ? session.projectId === opts.project : true,
        stored.timestamp,
        nq,
        stored.content,
        stored.fileRefs ?? [],
        nowMs,
        opts.repo ? session.repo === opts.repo : false,
        this.feedback?.delta(hit.turnId) ?? 0,
      );

      // Bi-temporal invalidation: demote superseded turns unless includeSuperseded is true
      const inv = this.temporal?.getInvalidation(hit.turnId, opts.asOf);
      if (inv && opts.includeSuperseded !== true) {
        score = Math.max(0, score - 0.35);
      }

      ranked.push({ hit, turn: stored, session, score });
    }
    ranked.sort((a, b) => b.score - a.score);

    // Neural Cross-Encoder precision reranking over top candidates (Phase B.2)
    if (opts.rerank === true && ranked.length > 1) {
      try {
        const topSlice = ranked.slice(0, RERANK_POOL);
        const candidates = topSlice.map((r) => ({
          id: r.hit.turnId,
          content: r.turn.content,
          score: r.score,
        }));
        const reranked = await this.reranker.rerank(rewritten.primaryQuery, candidates, RERANK_POOL);
        const byId = new Map(topSlice.map((r) => [r.hit.turnId, r]));
        const head = reranked.flatMap((item) => {
          const r = byId.get(item.id);
          if (!r) return [];
          r.score = item.combinedScore;
          return [r];
        });
        if (head.length === topSlice.length) {
          // The tail was never reranked and its raw scores are on another
          // scale: keep it strictly below the reranked head.
          const tail = ranked.slice(RERANK_POOL);
          const floor = Math.min(...head.map((r) => r.score));
          const tailTop = tail[0]?.score ?? 0;
          if (tailTop >= floor) {
            const scale = tailTop > 0 ? (floor * 0.99) / tailTop : 0;
            for (const r of tail) r.score *= scale;
          }
          ranked.splice(0, ranked.length, ...head, ...tail);
        }
      } catch {
        // Safe degradation: keep RRF ranking
      }
    }

    // Top sessions only (headroom for in-session merge + final cut).
    const topSessions: { session: Session; adapter: ContextAdapter }[] = [];
    const seenSessions = new Set<string>();
    for (const r of ranked) {
      const key = `${r.session.harness}:${r.session.id}`;
      if (seenSessions.has(key)) continue;
      const adapter = this.adapterFor(r.session.harness);
      if (!adapter) continue;
      seenSessions.add(key);
      topSessions.push({ session: r.session, adapter });
      if (topSessions.length >= maxResults + 2) break;
    }

    const turnsCache = new Map<string, Turn[]>();
    // Parallel: sessions are independent files.
    await Promise.all(
      topSessions.map(async ({ session, adapter }) => {
        turnsCache.set(session.id, await adapter.listTurns(session.id).catch(() => [] as Turn[]));
      }),
    );

    const perSession = new Map<string, { scored: { turn: Turn; score: number }[]; session: Session }>();
    for (const r of ranked) {
      const turns = turnsCache.get(r.session.id);
      if (!turns || turns.length === 0) continue;
      const idx = turns.findIndex((t) => t.id === r.hit.turnId);
      if (idx < 0) continue; // indexed but gone from truth — skip, never serve stale
      const key = `${r.session.harness}:${r.session.id}`;
      const entry = perSession.get(key) ?? { scored: [], session: r.session };
      entry.scored.push({ turn: turns[idx], score: r.score });
      perSession.set(key, entry);
    }

    // Merge overlapping windows per session; center = best score.
    const packaged: PackagedResult[] = [];
    for (const { scored, session } of perSession.values()) {
      const turns = turnsCache.get(session.id) ?? [];
      const order = new Map(turns.map((t, i) => [t.id, i]));
      scored.sort((a, b) => b.score - a.score);
      const claimed = new Set<string>();
      for (const s of scored) {
        if (claimed.has(s.turn.id)) continue;
        const center = order.get(s.turn.id) ?? 0;
        const window = turns.slice(Math.max(0, center - half), center + half + 1);
        for (const w of window) claimed.add(w.id);
        packaged.push(this.package(s, window, session, opts.asOf));
        if (packaged.length >= maxResults * 3) break; // over-collect, trim below
      }
    }

    packaged.sort((a, b) => b.score - a.score);
    const trimmed = packaged.slice(0, maxResults).map((p) => this.applyTokenBudget(p, maxTokens));
    return { query: nq, scope: effectiveScope, results: trimmed, searchedAt: now };
  }

  private package(
    s: { turn: Turn; score: number },
    window: Turn[],
    session: Session,
    asOf?: string,
  ): PackagedResult {
    const lines = s.turn.content.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 2);
    const summary = lines.map((l) => (l.length > 200 ? l.slice(0, 200) + "…" : l)).join("\n");
    const artifacts = [...new Set(window.flatMap((t) => extractArtifacts(t.content)))].slice(0, 20);
    const inv = this.temporal?.getInvalidation(s.turn.id, asOf);
    return {
      score: s.score,
      summary,
      provenance: {
        harness: session.harness,
        agentId: session.agentId,
        sessionId: session.id,
        turnId: s.turn.id,
        timestamp: s.turn.timestamp,
        sourcePath: session.sourcePath,
        byteOffset: s.turn.byteOffset,
      },
      context: window,
      artifacts,
      invalidation: inv ?? undefined,
      isSuperseded: inv !== null && inv !== undefined,
    };
  }

  /** Trim window edges (keep center) until chars fit maxTokens*4. */
  private applyTokenBudget(p: PackagedResult, maxTokens: number): PackagedResult {
    const budget = maxTokens * 4;
    let total = p.context.reduce((n, t) => n + t.content.length, 0);
    if (total <= budget) return p;
    const centerId = p.provenance.turnId;
    let ci = p.context.findIndex((t) => t.id === centerId);
    if (ci < 0) ci = Math.floor(p.context.length / 2);
    let lo = ci;
    let hi = ci;
    total = p.context[ci].content.length;
    // Expand outward alternately while budget allows (nearer turns first).
    while ((lo > 0 || hi < p.context.length - 1) && total < budget) {
      const dLo = lo > 0 ? ci - (lo - 1) : Infinity;
      const dHi = hi < p.context.length - 1 ? hi + 1 - ci : Infinity;
      if (dLo <= dHi) {
        lo -= 1;
        total += p.context[lo].content.length;
      } else {
        hi += 1;
        total += p.context[hi].content.length;
      }
    }
    return { ...p, context: p.context.slice(lo, hi + 1) };
  }
}
