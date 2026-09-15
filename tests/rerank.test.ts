/**
 * Unit tests for Neural Cross-Encoder Reranker (@xenova/transformers ONNX).
 */
import { describe, it, expect } from "vitest";
import { CrossEncoderReranker } from "../src/search/rerank.js";

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

  it("handles empty candidate lists safely", async () => {
    const reranker = new CrossEncoderReranker();
    const results = await reranker.rerank("some query", []);
    expect(results).toEqual([]);
  });
});
