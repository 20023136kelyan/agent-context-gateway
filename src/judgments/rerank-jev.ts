/**
 * Jev reranker — pairwise typed judgments over the candidate pool.
 *
 * Satisfies the shared `Reranker` interface, which is what
 * `SearchService.setReranker` accepts, so it substitutes at that boundary with
 * no change to SearchService.
 *
 * Two scoring modes, because they are genuinely different questions and the
 * eval has to decide between them rather than us:
 *
 *   "pairwise"— one request per candidate, judged alone. The cookbook's shape,
 *               and it matches a cross-encoder's independent-pair semantics.
 *   "fanout"  — one request, one Noul per candidate over shared state, so
 *               candidates are visible to each other. Cheaper: one request
 *               instead of N.
 *
 * DEFAULT IS PAIRWISE, on measurement rather than intuition. Fan-out looked
 * strictly better in prototyping — 904ms vs 1683ms for 15 candidates, and 15x
 * fewer requests — but on the fixture golden set it scores materially worse:
 *
 *   lexical-jev-pairwise  NDCG@5 0.842 / 0.842 / 0.833   P@1 0.800
 *   lexical-jev (fanout)  NDCG@5 0.759 / 0.737 / 0.751   P@1 0.600
 *
 * Splitting one context across 15 candidates appears to cost each judgment the
 * focused attention it needs, and it is noisier run-to-run (0.022 spread vs
 * 0.009). Fan-out remains available for rate-limited or cost-sensitive callers.
 */
import {
  RERANK_CONTENT_CHARS,
  RERANK_MODEL_WEIGHT,
  type RerankCandidate,
  type RerankResult,
} from "../search/reranker.js";
import { httpJevClient, type JevClient, type NoulQuestion } from "./jev.js";
import { scrubText } from "../security/scrub.js";

export type JevScoringMode = "fanout" | "pairwise";

const CRITERIA = {
  true: "The candidate states the answer, decision, or reason the query asks about.",
  false: "The candidate is only on a similar topic, or mentions the subject without resolving it.",
} as const;

/** Same shape as `noopReranker`: scores pass through, flagged `neural: false`. */
function passthrough(pool: RerankCandidate[]): RerankResult[] {
  return pool.map((c) => ({
    id: c.id,
    originalScore: c.score,
    rerankScore: c.score,
    combinedScore: c.score,
    neural: false,
  }));
}

function blend(pool: RerankCandidate[], scores: Map<string, number>): RerankResult[] {
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
}

export class JevReranker {
  readonly name: string;

  constructor(
    private mode: JevScoringMode = "pairwise",
    private client: JevClient = httpJevClient,
  ) {
    this.name = `JevReranker(${mode})`;
  }

  async rerank(query: string, candidates: RerankCandidate[], topK = 15): Promise<RerankResult[]> {
    if (candidates.length === 0) return [];
    const pool = candidates.slice(0, topK);
    try {
      const scores = this.mode === "fanout" ? await this.fanout(query, pool) : await this.pairwise(query, pool);
      // A short or misaligned response is the likeliest bug in this design and
      // it fails QUIETLY — wrong scores, plausible-looking order. Refuse it and
      // degrade instead, so `neural: false` tells the truth downstream.
      if (scores.size !== pool.length) {
        process.stderr.write(`[jev] expected ${pool.length} judgments, got ${scores.size} — degrading to retrieval order\n`);
        return passthrough(pool);
      }
      return blend(pool, scores);
    } catch (e) {
      process.stderr.write(`[jev] rerank failed (${(e as Error).message.slice(0, 120)}) — degrading to retrieval order\n`);
      return passthrough(pool);
    }
  }

  /** One request, N questions. Candidates share state and see each other. */
  private async fanout(query: string, pool: RerankCandidate[]): Promise<Map<string, number>> {
    const questions: Record<string, NoulQuestion> = {};
    // Positional keys, mapped back by index. The candidate ids are turn ids
    // (harness:session:uuid) and are not safe as question keys.
    pool.forEach((_, i) => {
      questions[`c${i}`] = {
        instructions: `Does \`candidates[${i}]\` contain the answer to \`query\`?`,
        criteria: CRITERIA,
      };
    });
    const state = {
      query,
      // Scrub before truncating: a cut can split a secret past recognition.
      candidates: pool.map((c) => scrubText(c.content).slice(0, RERANK_CONTENT_CHARS)),
    };
    const { answers } = await this.client.noul(state, questions);
    const scores = new Map<string, number>();
    pool.forEach((c, i) => {
      const v = answers[`c${i}`];
      if (typeof v === "number") scores.set(c.id, v);
    });
    return scores;
  }

  /** One request per candidate, judged in isolation — the cookbook's shape. */
  private async pairwise(query: string, pool: RerankCandidate[]): Promise<Map<string, number>> {
    const results = await Promise.all(
      pool.map(async (c) => {
        const { answers } = await this.client.noul(
          { query, candidate: scrubText(c.content).slice(0, RERANK_CONTENT_CHARS) },
          { answers_query: { instructions: "Does `candidate` contain the answer to `query`?", criteria: CRITERIA } },
        );
        return [c.id, answers.answers_query] as const;
      }),
    );
    const scores = new Map<string, number>();
    for (const [id, v] of results) if (typeof v === "number") scores.set(id, v);
    return scores;
  }
}
