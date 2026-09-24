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
  rerankText,
  RERANK_MODEL_WEIGHT,
  type RerankCandidate,
  type RerankResult,
} from "../search/reranker.js";
import { httpJevClient, type JevClient, type NoulQuestion } from "./jev.js";

export type JevScoringMode = "fanout" | "pairwise";

/**
 * What the reranker asks Jev about each candidate.
 *
 * `answer` (default) asks whether the candidate CONTAINS the answer. `work`
 * asks whether the earlier session is relevant prior work, on the theory that
 * "a previous chat was working on the risk feature, continue that" wants the
 * session that DID the work rather than one stating an answer.
 *
 * Measured 2026-09-23, jev-pairwise, project-scoped, NDCG@5 answer vs work:
 * real strict (14) 0.775 vs 0.770, real broad (27) 0.605 vs 0.598, synthetic
 * fixture (68) 0.966 vs 0.974 — a tie. Individual queries moved both ways,
 * and the continuation ask that prompted this ranked the same under both: the
 * single run where `answer` seemed to demote it was largely Jev's run-to-run
 * variance. Kept as a switch (JEV_RERANK_CRITERION, read per call) to re-test
 * on a larger eval; not a lever at this size.
 */
export type JevCriterion = "answer" | "work";

export function jevCriterion(): JevCriterion {
  return process.env.JEV_RERANK_CRITERION === "work" ? "work" : "answer";
}

const QUESTIONS: Record<JevCriterion, { single: string; indexed: (i: number) => string; criteria: { true: string; false: string } }> = {
  answer: {
    single: "Does `candidate` contain the answer to `query`?",
    indexed: (i) => `Does \`candidates[${i}]\` contain the answer to \`query\`?`,
    criteria: {
      true: "The candidate states the answer, decision, or reason the query asks about.",
      false: "The candidate is only on a similar topic, or mentions the subject without resolving it.",
    },
  },
  work: {
    single:
      "`query` is a request an agent has just been given. `candidate` is an excerpt from an earlier agent session. Is that earlier session relevant prior work for this request?",
    indexed: (i) =>
      `\`query\` is a request an agent has just been given. \`candidates[${i}]\` is an excerpt from an earlier agent session. Is that earlier session relevant prior work for this request?`,
    criteria: {
      true: "The excerpt is part of work on the same task, feature, bug, file or decision the request is about, including work the request asks to continue, check or redo, or it directly answers the request.",
      false: "The excerpt is about a different task and only shares topic words or general subject matter with the request.",
    },
  },
};

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
        instructions: QUESTIONS[jevCriterion()].indexed(i),
        criteria: QUESTIONS[jevCriterion()].criteria,
      };
    });
    const state = {
      query,
      candidates: pool.map((c) => rerankText(c.content, query)),
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
    const criterion = jevCriterion();
    const results = await Promise.all(
      pool.map(async (c) => {
        const { answers } = await this.client.noul(
          { query, candidate: rerankText(c.content, query) },
          { answers_query: { instructions: QUESTIONS[criterion].single, criteria: QUESTIONS[criterion].criteria } },
        );
        return [c.id, answers.answers_query] as const;
      }),
    );
    const scores = new Map<string, number>();
    for (const [id, v] of results) if (typeof v === "number") scores.set(id, v);
    return scores;
  }
}
