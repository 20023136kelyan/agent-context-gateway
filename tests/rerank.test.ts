/**
 * Unit tests for Neural Cross-Encoder Reranker (@xenova/transformers ONNX).
 */
import { describe, it, expect } from "vitest";
import { CrossEncoderReranker, RERANK_MODEL_WEIGHT } from "../src/search/rerank.js";

describe("CrossEncoderReranker", () => {
  it("initializes and re-ranks matching vs un-matching candidates accurately", async () => {
    const reranker = new CrossEncoderReranker();
    const query = "How should teammates edit together in a shared session?";
    const candidates = [
      { id: "unrelated", content: "The quarterly budget meeting takes place in room 3B on Friday", score: 0.8 },
      { id: "relevant", content: "Realtime collaboration between agents uses a shared workspace session with live editing", score: 0.5 },
      { id: "tangential", content: "We should replace the code editor with a new component", score: 0.6 },
    ];

    const results = await reranker.rerank(query, candidates, 3);
    expect(results.length).toBe(3);
    // Relevant candidate should be boosted to top
    expect(results[0].id).toBe("relevant");
    expect(results[0].rerankScore).toBeGreaterThan(results[1].rerankScore);
  }, 90000);

  it("blends the model score with the upstream score, and does not replace it", async () => {
    // Regression guard. `combinedScore = rerankScore` scores better on the
    // fixture corpus, but `finalScore` — which is what `cand.score` carries —
    // is where feedback.delta, project/repo boosts and recency live. Unblending
    // here zeroes all three for the reranked head of every `?rerank=true`
    // search, and the fixture corpus (one project, no feedback) cannot see the
    // cost. Callers who want the unblended order ask for it via `rawRank`.
    const reranker = new CrossEncoderReranker();
    const results = await reranker.rerank("shared editing session", [
      { id: "a", content: "Realtime collaboration uses a shared workspace session", score: 0.9 },
      { id: "b", content: "The quarterly budget meeting is in room 3B", score: 0.1 },
    ]);

    for (const r of results) {
      const expected = RERANK_MODEL_WEIGHT * r.rerankScore + (1 - RERANK_MODEL_WEIGHT) * r.originalScore;
      expect(r.combinedScore).toBeCloseTo(expected, 10);
      expect(r.combinedScore).not.toBeCloseTo(r.rerankScore, 10); // not the model alone
    }
    // And the upstream score must be preserved, not overwritten by the blend.
    expect(results.find((r) => r.id === "a")!.originalScore).toBe(0.9);
    expect(results.find((r) => r.id === "b")!.originalScore).toBe(0.1);
  }, 90000);

  it("handles empty candidate lists safely", async () => {
    const reranker = new CrossEncoderReranker();
    const results = await reranker.rerank("some query", []);
    expect(results).toEqual([]);
  });
});
