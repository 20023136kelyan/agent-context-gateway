/**
 * Golden Evaluation Harness Runner.
 * Runs stratified benchmark queries from tests/eval/golden.json across retrieval modes
 * and outputs NDCG@5, MRR@5, Precision@1, Precision@5, latency and citation metrics.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createApp, closeApp, initVectors, type GatewayApp } from "../app.js";
import { searchOnce, decideOnce } from "../commands.js";
import { ndcgAtK, mrrAtK, precisionAtK, evaluateCitations, citationHitAtK } from "./metrics.js";
import type { Harness } from "../core/models.js";
import type { SearchOptions } from "../search/search.js";
import { noopReranker, type Reranker } from "../search/reranker.js";
import { JevReranker } from "../judgments/rerank-jev.js";
import { VoyageReranker } from "../search/rerank-voyage.js";
import { HttpReranker } from "../search/rerank-http.js";
import { JevDecisionJudge } from "../judgments/judge-jev.js";
import type { DecisionJudge } from "../decisions/extract.js";
import { HeuristicJudge } from "../decisions/extract.js";

export interface GoldenQuery {
  id: string;
  /** True when the target session actually contains an extractable decision.
   *  Citation metrics use this when present, because selecting the subset by a
   *  regex on the QUERY measures retrieval failure and calls it judge quality:
   *  a query can start with "why" while its answer holds no decision at all. */
  decisionQuery?: boolean;
  domain: "code" | "prose" | "paraphrase";
  query: string;
  harness?: Harness;
  description: string;
  relevantSessionIds: string[];
  /**
   * Per-query corpus cutoff, overriding the run's `--as-of`. Real-history
   * pairs need it: each query was asked at a different moment, and it may
   * only find what existed then — never its own session or later ones.
   */
  asOf?: string;
  /** The project the query was asked from, for --project-scope runs. */
  project?: string;
}

/**
 * How a query's `project` is applied: not at all (global search, today's
 * default), as a hard filter, or as a soft preference (SearchOptions).
 */
export type ProjectScope = "none" | "filter" | "prefer";

export interface QueryEvalResult {
  id: string;
  domain: string;
  query: string;
  ndcg5: number;
  mrr5: number;
  p1: number;
  p5: number;
  latencyMs: number;
  topSessionIds: string[];
  hit: boolean;
}

export interface DomainAggregate {
  domain: string;
  count: number;
  meanNdcg5: number;
  meanMrr5: number;
  meanP1: number;
  meanP5: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
}

export interface EvalRunResult {
  mode: string;
  /** Index size at the start of the run. Compare across arms: if it moved, an
   *  external writer (serve --watch) was committing mid-run and BM25 corpus
   *  statistics drifted underneath the comparison. */
  docCount?: number;
  /** Which reranker and judge produced these numbers. A baseline that does not
   *  say is a baseline that gets misread later. */
  reranker?: string;
  judgeMethod?: string;
  timestamp: string;
  /** Corpus cutoff this run was pinned to; absent means "whatever was indexed at run time", which is not reproducible. */
  asOf?: string;
  totalQueries: number;
  overall: DomainAggregate;
  byDomain: Record<string, DomainAggregate>;
  queryResults: QueryEvalResult[];
  decisionCitations?: {
    meanPrecision: number;
    meanRecall: number;
    /** Top cited session is relevant. Unlike the set metrics, this moves when a
     *  judge reorders, which is the only thing a judge can do. */
    meanHitAt1: number;
    /** Queries where decide returned nothing at all — a retrieval failure, not
     *  a judge failure, and the dominant term in the set metrics. */
    emptyResults: number;
    /** Share of cited decisions actually carrying the arm's judge method.
     *
     *  `JevDecisionJudge.judge` catches every error and returns the heuristic
     *  candidates untouched, so a dead API key, a 429 or a timeout produces a
     *  plausible-looking result that is simply the baseline. `judgeMethod`
     *  cannot reveal that — it reports what was REQUESTED. This reports what
     *  came back. Anything below 1 on a judge arm means some judgments did not
     *  happen, and the arm's numbers are not a measurement of that judge. */
    judgedShare?: number;
  };
}

export type EvalMode =
  | "lexical"
  | "hybrid"
  | "rrf"
  // Jev arms mirror lexical/hybrid retrieval exactly, differing only in the
  // installed reranker, so a delta is attributable to the model alone.
  | "lexical-jev"
  | "jev"
  | "lexical-jev-pairwise"
  | "jev-pairwise"
  // Pooled-judging arm: identical retrieval to jev-pairwise, but rawRank
  // bypasses RRF weights and boosts so final order is the model alone.
  | "jev-pure"
  // Voyage reranker bake-off: same hybrid pool, vendor listwise model.
  // Model comes from VOYAGE_RERANK_MODEL per cell (2.5 / lite / 3).
  | "rerank-voyage"
  // Self-hosted bake-off: same hybrid pool, the model behind GATEWAY_RERANK_URL.
  | "rerank-http"
  // Judge arms vary only the decision judge, so decisionCitations is
  // attributable to it; retrieval and reranking are held fixed at lexical.
  // judge-heuristic (passthrough) is the extraction-only baseline: what the
  // candidates alone are worth before any model judges them.
  | "judge-heuristic"
  | "judge-jev"
  | "judge-jev-noul";

/**
 * A fully-specified comparison arm.
 *
 * `{semantic, rerank}` stopped being sufficient once there is more than one
 * reranker: a voyage arm and a Jev arm have IDENTICAL SearchOptions and
 * differ only in which object `setReranker` holds.
 *
 * `reranker` is deliberately NOT optional. `SearchService.setReranker` mutates a
 * service shared across arms and there is no getter, so an arm that declines to
 * set one silently inherits whatever the previous arm installed — and a later
 * `rerank: true` arm would then measure the wrong model without any error.
 * Every arm states its reranker; `runEval` sets it unconditionally.
 */
export interface EvalArm {
  name: string;
  search: Required<Pick<SearchOptions, "semantic" | "rerank">> & Pick<SearchOptions, "rawRank">;
  reranker: () => Reranker;
  judge?: () => DecisionJudge;
}

const JEV_ARMS: Record<string, { semantic: boolean; jevMode: "fanout" | "pairwise"; rawRank?: boolean }> = {
  "lexical-jev": { semantic: false, jevMode: "fanout" },
  jev: { semantic: true, jevMode: "fanout" },
  "lexical-jev-pairwise": { semantic: false, jevMode: "pairwise" },
  "jev-pairwise": { semantic: true, jevMode: "pairwise" },
  "jev-pure": { semantic: true, jevMode: "pairwise", rawRank: true },
};

const JUDGE_ARMS: Record<string, () => DecisionJudge> = {
  "judge-heuristic": () => new HeuristicJudge(),
  "judge-jev": () => new JevDecisionJudge(),
  // Noul only: isolates the decision-state Score's contribution.
  "judge-jev-noul": () => new JevDecisionJudge(undefined, false),
};

export function armFor(mode: EvalMode): EvalArm {
  const judgeArm = JUDGE_ARMS[mode];
  if (judgeArm) {
    return {
      name: mode,
      search: { semantic: false, rerank: false },
      reranker: () => noopReranker,
      judge: judgeArm,
    };
  }
  const jev = JEV_ARMS[mode];
  if (jev) {
    return {
      name: mode,
      search: { semantic: jev.semantic, rerank: true, ...(jev.rawRank ? { rawRank: true as const } : {}) },
      reranker: () => new JevReranker(jev.jevMode),
    };
  }
  if (mode === "rerank-voyage") {
    return {
      name: mode,
      search: { semantic: true, rerank: true },
      reranker: () => new VoyageReranker(),
    };
  }
  if (mode === "rerank-http") {
    return {
      name: mode,
      search: { semantic: true, rerank: true },
      reranker: () => new HttpReranker(),
    };
  }
  return { name: mode, search: modeOptions(mode), reranker: () => noopReranker };
}

/** Search options per eval mode. "rrf" is the pre-rename alias of "hybrid" (vectors + RRF fusion). */
export function modeOptions(mode: EvalMode): Required<Pick<SearchOptions, "semantic" | "rerank">> {
  if (mode === "lexical") return { semantic: false, rerank: false };
  // Jev/voyage arms are described by armFor, not here.
  const jev = JEV_ARMS[mode];
  if (jev) return { semantic: jev.semantic, rerank: true };
  if (mode === "rerank-voyage" || mode === "rerank-http") return { semantic: true, rerank: true };
  if (JUDGE_ARMS[mode]) return { semantic: false, rerank: false };
  return { semantic: true, rerank: false };
}

export function loadGoldenQueries(path?: string): GoldenQuery[] {
  const p = path ?? join(process.cwd(), "tests", "eval", "golden.json");
  return JSON.parse(readFileSync(p, "utf8")) as GoldenQuery[];
}

function aggregate(results: QueryEvalResult[], domain: string): DomainAggregate {
  const n = results.length;
  if (n === 0) {
    return { domain, count: 0, meanNdcg5: 0, meanMrr5: 0, meanP1: 0, meanP5: 0, p50LatencyMs: 0, p95LatencyMs: 0 };
  }
  const lats = results.map((r) => r.latencyMs).sort((a, b) => a - b);
  const p50 = lats[Math.floor(n * 0.5)];
  const p95 = lats[Math.floor(n * 0.95)] ?? lats[n - 1];
  return {
    domain,
    count: n,
    meanNdcg5: Number((results.reduce((s, r) => s + r.ndcg5, 0) / n).toFixed(4)),
    meanMrr5: Number((results.reduce((s, r) => s + r.mrr5, 0) / n).toFixed(4)),
    meanP1: Number((results.reduce((s, r) => s + r.p1, 0) / n).toFixed(4)),
    meanP5: Number((results.reduce((s, r) => s + r.p5, 0) / n).toFixed(4)),
    p50LatencyMs: Math.round(p50),
    p95LatencyMs: Math.round(p95),
  };
}

export async function runEval(
  app: GatewayApp,
  queries: GoldenQuery[],
  mode: EvalMode | EvalArm,
  opts: {
    asOf?: string;
    projectScope?: ProjectScope;
    maxResults?: number;
    /** Sees each query's results as returned, after timing (payload dumps). */
    onResults?: (q: GoldenQuery, results: Awaited<ReturnType<typeof searchOnce>>["results"]) => Promise<void>;
  } = {},
): Promise<EvalRunResult> {
  const queryResults: QueryEvalResult[] = [];
  const arm: EvalArm = typeof mode === "string" ? armFor(mode) : mode;
  const modeOpts = arm.search;
  // Unconditional: see EvalArm. An arm must never inherit the previous one's model.
  const reranker = arm.reranker();
  app.search.setReranker(reranker);
  const judge = arm.judge?.();
  // Pins the corpus: without it, sessions indexed after the golden set was
  // authored (this evaluator's own transcript included) compete with truth.
  const asOf = opts.asOf;

  for (const [idx, q] of queries.entries()) {
    const t0 = Date.now();
    process.stderr.write(`[eval ${idx + 1}/${queries.length}] ${q.id}: ${q.query.slice(0, 35)}... `);
    const scoped = q.project && opts.projectScope === "filter" ? { project: q.project }
      : q.project && opts.projectScope === "prefer" ? { preferProject: q.project }
      : {};
    const res = await searchOnce(app, q.query, {
      harness: q.harness,
      // 5 turns is what an agent is shown. More gives a deeper session ranking
      // (judged pools); NDCG@5 still reads the first five distinct sessions.
      maxResults: opts.maxResults ?? 5,
      asOf: q.asOf ?? asOf,
      ...scoped,
      ...modeOpts,
    });
    const latencyMs = Date.now() - t0;
    process.stderr.write(`${latencyMs}ms\n`);
    await opts.onResults?.(q, res.results);

    const rankedSessionIds = res.results.map((r) => r.provenance.sessionId);
    // Distinct in order of first appearance
    const uniqueRankedSessionIds = [...new Set(rankedSessionIds)];

    const ndcg5 = ndcgAtK(uniqueRankedSessionIds, q.relevantSessionIds, 5);
    const mrr5 = mrrAtK(uniqueRankedSessionIds, q.relevantSessionIds, 5);
    const p1 = precisionAtK(uniqueRankedSessionIds, q.relevantSessionIds, 1);
    const p5 = precisionAtK(uniqueRankedSessionIds, q.relevantSessionIds, 5);
    const hit = mrr5 > 0;

    queryResults.push({
      id: q.id,
      domain: q.domain,
      query: q.query,
      ndcg5,
      mrr5,
      p1,
      p5,
      latencyMs,
      topSessionIds: uniqueRankedSessionIds.slice(0, 10),
      hit,
    });
  }

  // Domain aggregates
  const domains = [...new Set(queries.map((q) => q.domain))];
  const byDomain: Record<string, DomainAggregate> = {};
  for (const d of domains) {
    byDomain[d] = aggregate(queryResults.filter((r) => r.domain === d), d);
  }
  const overall = aggregate(queryResults, "overall");

  // ALCE-style decision citation evaluation on "why" queries
  let decisionCitations: EvalRunResult["decisionCitations"];
  const flagged = queries.filter((q) => q.decisionQuery);
  const whyQueries = flagged.length > 0 ? flagged : queries.filter((q) => /why|decide|choose|stopped|replace/i.test(q.query));
  if (whyQueries.length > 0) {
    let totalP = 0;
    let totalR = 0;
    let totalHit1 = 0;
    let empty = 0;
    let citedTotal = 0;
    let citedJudged = 0;
    for (const wq of whyQueries) {
      try {
        const dec = await decideOnce(app, wq.query, { harness: wq.harness, semantic: modeOpts.semantic, asOf: wq.asOf ?? asOf, judge });
        if (judge) {
          citedTotal += dec.decisions.length;
          citedJudged += dec.decisions.filter((d) => d.method === judge.method).length;
        }
        const citedSessions = dec.decisions.map((d) => d.session.sessionId);
        const evalScore = evaluateCitations(citedSessions, wq.relevantSessionIds);
        totalP += evalScore.citationPrecision;
        totalR += evalScore.citationRecall;
        totalHit1 += citationHitAtK(citedSessions, wq.relevantSessionIds, 1);
        if (citedSessions.length === 0) empty += 1;
      } catch {
        // skip failed decision extraction
      }
    }
    decisionCitations = {
      meanPrecision: Number((totalP / whyQueries.length).toFixed(4)),
      meanRecall: Number((totalR / whyQueries.length).toFixed(4)),
      meanHitAt1: Number((totalHit1 / whyQueries.length).toFixed(4)),
      emptyResults: empty,
      ...(judge && citedTotal > 0 ? { judgedShare: Number((citedJudged / citedTotal).toFixed(4)) } : {}),
    };
  }

  return {
    mode: arm.name,
    docCount: (() => {
      try {
        return app.index.docCount();
      } catch {
        return undefined;
      }
    })(),
    reranker: reranker.constructor?.name ?? "unknown",
    judgeMethod: judge?.method,
    timestamp: new Date().toISOString(),
    asOf,
    totalQueries: queries.length,
    overall,
    byDomain,
    queryResults,
    decisionCitations,
  };
}

export function formatMarkdownTable(run: EvalRunResult): string {
  const lines: string[] = [];
  lines.push(`### Evaluation Run: ${run.mode} (${run.totalQueries} queries)`);
  lines.push(`*Timestamp: ${run.timestamp}*`);
  lines.push(run.asOf ? `*Corpus as of: ${run.asOf}*` : `*Corpus: unpinned (not reproducible — pass --as-of)*`);
  lines.push("");
  lines.push("| Domain | Queries | NDCG@5 | MRR@5 | P@1 | P@5 | p50 (ms) | p95 (ms) |");
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const d of Object.values(run.byDomain)) {
    lines.push(
      `| ${d.domain} | ${d.count} | ${d.meanNdcg5.toFixed(3)} | ${d.meanMrr5.toFixed(3)} | ${d.meanP1.toFixed(3)} | ${d.meanP5.toFixed(3)} | ${d.p50LatencyMs} | ${d.p95LatencyMs} |`,
    );
  }
  lines.push(
    `| **Overall** | **${run.overall.count}** | **${run.overall.meanNdcg5.toFixed(3)}** | **${run.overall.meanMrr5.toFixed(3)}** | **${run.overall.meanP1.toFixed(3)}** | **${run.overall.meanP5.toFixed(3)}** | **${run.overall.p50LatencyMs}** | **${run.overall.p95LatencyMs}** |`,
  );
  if (run.decisionCitations) {
    lines.push("");
    const dc = run.decisionCitations;
    lines.push(
      `**Decision Citations:** Hit@1 = ${dc.meanHitAt1.toFixed(3)} (judge-sensitive) · ` +
        `Precision = ${dc.meanPrecision.toFixed(3)}, Recall = ${dc.meanRecall.toFixed(3)} (set overlap, judge-insensitive) · ` +
        `empty = ${dc.emptyResults}` +
        (dc.judgedShare !== undefined ? ` · judged = ${(dc.judgedShare * 100).toFixed(0)}% of citations` : ""),
    );
    if (dc.judgedShare !== undefined && dc.judgedShare < 1) {
      lines.push(
        `> **Judge did not run on every citation** (judged ${(dc.judgedShare * 100).toFixed(0)}% of cited ` +
          `decisions). The judge swallows its own errors and returns heuristic order, so the numbers above ` +
          `are partly the baseline, not this judge. Treat them as invalid until this reads 100%.`,
      );
    }
  }
  return lines.join("\n");
}
