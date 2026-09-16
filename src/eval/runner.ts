/**
 * Golden Evaluation Harness Runner.
 * Runs stratified benchmark queries from tests/eval/golden.json across retrieval modes
 * and outputs NDCG@5, MRR@5, Precision@1, Precision@5, latency and citation metrics.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createApp, closeApp, initVectors, type GatewayApp } from "../app.js";
import { searchOnce, decideOnce } from "../commands.js";
import { ndcgAtK, mrrAtK, precisionAtK, evaluateCitations } from "./metrics.js";
import type { Harness } from "../core/models.js";
import type { SearchOptions } from "../search/search.js";

export interface GoldenQuery {
  id: string;
  domain: "code" | "prose" | "paraphrase";
  query: string;
  harness?: Harness;
  description: string;
  relevantSessionIds: string[];
}

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
  };
}

export type EvalMode = "lexical" | "lexical-rerank" | "hybrid" | "rerank" | "rrf";

/** Search options per eval mode. "rrf" is the pre-rename alias of "hybrid" (vectors + RRF fusion). */
export function modeOptions(mode: EvalMode): Required<Pick<SearchOptions, "semantic" | "rerank">> {
  if (mode === "lexical") return { semantic: false, rerank: false };
  // Lexical candidates + cross-encoder: precision without vector noise in the pool.
  if (mode === "lexical-rerank") return { semantic: false, rerank: true };
  if (mode === "rerank") return { semantic: true, rerank: true };
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
  mode: EvalMode,
  opts: { asOf?: string } = {},
): Promise<EvalRunResult> {
  const queryResults: QueryEvalResult[] = [];
  const modeOpts = modeOptions(mode);
  // Pins the corpus: without it, sessions indexed after the golden set was
  // authored (this evaluator's own transcript included) compete with truth.
  const asOf = opts.asOf;

  for (const [idx, q] of queries.entries()) {
    const t0 = Date.now();
    process.stderr.write(`[eval ${idx + 1}/${queries.length}] ${q.id}: ${q.query.slice(0, 35)}... `);
    const res = await searchOnce(app, q.query, {
      harness: q.harness,
      maxResults: 5,
      asOf,
      ...modeOpts,
    });
    const latencyMs = Date.now() - t0;
    process.stderr.write(`${latencyMs}ms\n`);

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
      topSessionIds: uniqueRankedSessionIds.slice(0, 5),
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
  let decisionCitations: { meanPrecision: number; meanRecall: number } | undefined;
  const whyQueries = queries.filter((q) => /why|decide|choose|stopped|replace/i.test(q.query));
  if (whyQueries.length > 0) {
    let totalP = 0;
    let totalR = 0;
    for (const wq of whyQueries) {
      try {
        const dec = await decideOnce(app, wq.query, { harness: wq.harness, semantic: modeOpts.semantic, asOf });
        const citedSessions = dec.decisions.map((d) => d.session.sessionId);
        const evalScore = evaluateCitations(citedSessions, wq.relevantSessionIds);
        totalP += evalScore.citationPrecision;
        totalR += evalScore.citationRecall;
      } catch {
        // skip failed decision extraction
      }
    }
    decisionCitations = {
      meanPrecision: Number((totalP / whyQueries.length).toFixed(4)),
      meanRecall: Number((totalR / whyQueries.length).toFixed(4)),
    };
  }

  return {
    mode,
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
    lines.push(`**ALCE Decision Citations:** Precision = ${run.decisionCitations.meanPrecision.toFixed(3)}, Recall = ${run.decisionCitations.meanRecall.toFixed(3)}`);
  }
  return lines.join("\n");
}
