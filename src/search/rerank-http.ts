/**
 * Self-hosted reranker: any rerank endpoint the operator runs.
 *
 * The hosted rerankers (Jev, Voyage) bill per search. This one calls a model
 * the operator serves, such as an open-weights reranker behind vLLM or TEI on
 * their own GPU, so a search costs GPU time and nothing per call.
 *
 *   GATEWAY_RERANK_URL     the endpoint, e.g. http://10.0.0.5:8000/v1/rerank
 *   GATEWAY_RERANK_MODEL   the model name the server expects (optional)
 *   GATEWAY_RERANK_KEY     bearer token, if the server wants one (optional)
 *   GATEWAY_RERANK_QUERY_TEMPLATE / GATEWAY_RERANK_DOC_TEMPLATE
 *                          wrap the query ({query}) and each excerpt ({doc})
 *                          for models that are prompted, such as
 *                          Qwen3-Reranker's instruction format (optional)
 *
 * Request: the Cohere/Jina shape vLLM serves, {model, query, documents,
 * top_n}. Replies are read in that shape ({results: [{index,
 * relevance_score}]}), Voyage's ({data: [...]}) or TEI's ([{index, score}]).
 * Scores are blended with the retrieval score on a 0-1 scale, as Jev's and
 * Voyage's are; a model that returns raw logits (any score of the batch outside
 * 0-1) is put through a sigmoid first.
 * Text is scrubbed like every off-machine call: the endpoint is the operator's,
 * but not necessarily this machine. Degrades to retrieval order with
 * neural:false, like the other rerankers.
 */
import {
  rerankText,
  RERANK_MODEL_WEIGHT,
  type RerankCandidate,
  type RerankResult,
} from "./reranker.js";
import { scrubText } from "../security/scrub.js";

const TIMEOUT_MS = Number(process.env.GATEWAY_RERANK_TIMEOUT_MS ?? 30_000);

export interface HttpRerankerConfig {
  url: string;
  model?: string;
  key?: string;
  queryTemplate?: string;
  docTemplate?: string;
}

export function httpRerankerConfig(env: NodeJS.ProcessEnv = process.env): HttpRerankerConfig | null {
  const url = env.GATEWAY_RERANK_URL?.trim();
  if (!url) return null;
  return {
    url,
    model: env.GATEWAY_RERANK_MODEL?.trim() || undefined,
    key: env.GATEWAY_RERANK_KEY?.trim() || undefined,
    queryTemplate: env.GATEWAY_RERANK_QUERY_TEMPLATE || undefined,
    docTemplate: env.GATEWAY_RERANK_DOC_TEMPLATE || undefined,
  };
}

/** Wall time of each call, for the eval's cost and latency report. */
export const httpRerankMeter = {
  requests: 0,
  failures: 0,
  ms: [] as number[],
  reset() {
    this.requests = 0;
    this.failures = 0;
    this.ms = [];
  },
  snapshot() {
    const s = [...this.ms].sort((a, b) => a - b);
    const at = (p: number) => (s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))]! : 0);
    return { requests: this.requests, failures: this.failures, p50Ms: Math.round(at(0.5)), p95Ms: Math.round(at(0.95)) };
  },
};

function passthrough(pool: RerankCandidate[]): RerankResult[] {
  return pool.map((c) => ({ id: c.id, originalScore: c.score, rerankScore: c.score, combinedScore: c.score, neural: false }));
}

/** Scores by candidate index, from any of the three reply shapes. */
export function readScores(body: unknown): Map<number, number> {
  const rows = Array.isArray(body)
    ? body
    : ((body as { results?: unknown[]; data?: unknown[] })?.results ?? (body as { data?: unknown[] })?.data ?? []);
  const out = new Map<number, number>();
  for (const r of rows as { index?: unknown; relevance_score?: unknown; score?: unknown }[]) {
    const score = typeof r?.relevance_score === "number" ? r.relevance_score : r?.score;
    if (typeof r?.index === "number" && typeof score === "number") out.set(r.index, score);
  }
  return out;
}

/** Probabilities pass through; a batch of raw logits is squashed to 0-1. */
export function toProbabilities(scores: number[]): number[] {
  return scores.some((s) => s < 0 || s > 1) ? scores.map((s) => 1 / (1 + Math.exp(-s))) : scores;
}

const fill = (template: string | undefined, slot: string, text: string) => (template ? template.split(slot).join(text) : text);

export class HttpReranker {
  readonly name = "HttpReranker";
  constructor(private config: HttpRerankerConfig | null = httpRerankerConfig()) {}

  async rerank(query: string, candidates: RerankCandidate[], topK = 15): Promise<RerankResult[]> {
    if (candidates.length === 0) return [];
    const pool = candidates.slice(0, topK);
    const cfg = this.config;
    if (!cfg) return passthrough(pool);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    const t0 = performance.now();
    try {
      const res = await fetch(cfg.url, {
        method: "POST",
        headers: { "content-type": "application/json", ...(cfg.key ? { authorization: `Bearer ${cfg.key}` } : {}) },
        body: JSON.stringify({
          ...(cfg.model ? { model: cfg.model } : {}),
          query: fill(cfg.queryTemplate, "{query}", scrubText(query)),
          documents: pool.map((c) => fill(cfg.docTemplate, "{doc}", rerankText(c.content, query))),
          top_n: pool.length,
        }),
        signal: ac.signal,
      });
      if (!res.ok) throw new Error(`rerank endpoint ${res.status}`);
      const scores = readScores(await res.json());
      if (scores.size !== pool.length) throw new Error(`rerank endpoint scored ${scores.size} of ${pool.length}`);
      httpRerankMeter.requests += 1;
      httpRerankMeter.ms.push(performance.now() - t0);
      const probs = toProbabilities(pool.map((_, i) => scores.get(i)!));
      const out = pool.map((c, i) => {
        const rerankScore = probs[i]!;
        return {
          id: c.id,
          originalScore: c.score,
          rerankScore,
          combinedScore: RERANK_MODEL_WEIGHT * rerankScore + (1 - RERANK_MODEL_WEIGHT) * c.score,
          neural: true,
        };
      });
      out.sort((a, b) => b.combinedScore - a.combinedScore);
      return out;
    } catch {
      httpRerankMeter.failures += 1;
      return passthrough(pool);
    } finally {
      clearTimeout(timer);
    }
  }
}
