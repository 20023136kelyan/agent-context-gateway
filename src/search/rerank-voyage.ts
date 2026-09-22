/**
 * Voyage reranker provider (remote).
 *
 * Implements the shared `Reranker` interface over POST /v1/rerank, so it drops
 * into `SearchService.setReranker` and every eval arm with no other changes.
 * One request scores the whole pool (vs Jev-pairwise's one-per-candidate),
 * with an optional natural-language instruction steering relevance.
 *
 * Model via VOYAGE_RERANK_MODEL (default rerank-2.5); the same VOYAGE_API_KEY
 * is the opt-in, same off-machine privacy terms as embeddings (see voyage.ts).
 * Degrades to retrieval order with neural:false, like the Jev reranker.
 */
import {
  RERANK_CONTENT_CHARS,
  RERANK_MODEL_WEIGHT,
  type RerankCandidate,
  type RerankResult,
} from "./reranker.js";
import { scrubText } from "../security/scrub.js";

const ENDPOINT = process.env.VOYAGE_ENDPOINT ?? "https://api.voyageai.com/v1/embeddings";
const RERANK_ENDPOINT = ENDPOINT.replace(/\/embeddings\/?$/, "") + "/rerank";
const TIMEOUT_MS = Number(process.env.VOYAGE_TIMEOUT_MS ?? 30_000);

export const VOYAGE_RERANK_PRICES_PER_M: Record<string, number> = {
  "rerank-2.5": 0.05,
  "rerank-2.5-lite": 0.02,
  "rerank-3": 0.05,
  "rerank-3-lite": 0.02,
};

export function voyageRerankModel(): string {
  return process.env.VOYAGE_RERANK_MODEL ?? "rerank-2.5";
}

/**
 * Process-wide usage meter (sweep cost accounting). Voyage bills rerank on
 * processed tokens: query_tokens x docs + doc tokens.
 */
export const voyageRerankMeter = {
  requests: 0,
  tokens: 0,
  reset() {
    this.requests = 0;
    this.tokens = 0;
  },
  snapshot() {
    return { requests: this.requests, tokens: this.tokens };
  },
};

function passthrough(pool: RerankCandidate[]): RerankResult[] {
  return pool.map((c) => ({
    id: c.id,
    originalScore: c.score,
    rerankScore: c.score,
    combinedScore: c.score,
    neural: false,
  }));
}

export class VoyageReranker {
  readonly name = "VoyageReranker";
  /** Override per call (cells pin VOYAGE_RERANK_MODEL instead). */
  constructor(private model?: string) {}

  async rerank(query: string, candidates: RerankCandidate[], topK = 15): Promise<RerankResult[]> {
    if (candidates.length === 0) return [];
    const key = process.env.VOYAGE_API_KEY;
    if (!key) return passthrough(candidates.slice(0, topK));
    const pool = candidates.slice(0, topK);
    const model = this.model ?? voyageRerankModel();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(RERANK_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model,
          query: scrubText(query),
          // Scrub before truncating: a cut can split a secret past recognition.
          documents: pool.map((c) => scrubText(c.content).slice(0, RERANK_CONTENT_CHARS)),
          top_k: pool.length,
          truncation: true,
        }),
        signal: ac.signal,
      });
      if (!res.ok) return passthrough(pool);
      const body = (await res.json()) as {
        data?: { index: number; relevance_score: number }[];
        usage?: { total_tokens?: number };
      };
      voyageRerankMeter.requests += 1;
      voyageRerankMeter.tokens += body.usage?.total_tokens ?? 0;
      const scores = new Map<string, number>();
      for (const d of body.data ?? []) {
        if (typeof d?.index === "number" && typeof d?.relevance_score === "number") {
          const c = pool[d.index];
          if (c) scores.set(c.id, d.relevance_score);
        }
      }
      if (scores.size !== pool.length) return passthrough(pool);
      const out = pool.map((c) => {
        const rerankScore = scores.get(c.id) ?? c.score;
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
      return passthrough(pool);
    } finally {
      clearTimeout(timer);
    }
  }
}
