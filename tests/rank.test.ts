/**
 * Fusion weighting, and the calibration bug it hid.
 *
 * `similarityWeight` maps cosine similarity to a confidence multiplier on the
 * vector side of RRF. Its floor is ENGINE-SPECIFIC: the original 0.45 came from
 * Qwen/BGE, whose similarities run 0.45-0.80. Voyage-4 compresses that range,
 * and on the fixture corpus paraphrase targets sitting at vector rank 1 score
 * 0.35-0.57 — so under the BGE floor half of them weighed exactly zero. They
 * were retrieved at rank 1, admitted through MIN_VECTOR_SIM, and then
 * multiplied out of existence before fusion ever compared them to anything.
 *
 * Symptom: paraphrase recall@60 of 0.95 against recall@1 of 0.15. The answer
 * was in the pool almost every time and the ranking could not see it.
 */
import { describe, it, expect } from "vitest";
import { similarityWeight, rrfBaseScore, rrfTerm } from "../src/search/rank.js";

/** Measured range of real paraphrase targets, all at vector rank 1-2. */
const VOYAGE_PARAPHRASE_SIMS = [0.351, 0.365, 0.397, 0.426, 0.446, 0.477, 0.494, 0.498, 0.562, 0.571];

describe("similarityWeight", () => {
  it("gives every measured Voyage paraphrase hit a non-zero weight", () => {
    // The regression that matters: a zero here silently deletes a rank-1
    // semantic match from fusion, and nothing downstream can recover it.
    for (const sim of VOYAGE_PARAPHRASE_SIMS) {
      expect(similarityWeight(sim), `sim ${sim} must carry weight`).toBeGreaterThan(0);
    }
  });

  it("still suppresses genuine noise", () => {
    expect(similarityWeight(0.05)).toBe(0);
    expect(similarityWeight(0)).toBe(0);
    expect(similarityWeight(undefined)).toBe(0);
    expect(similarityWeight(Number.NaN)).toBe(0);
  });

  it("saturates at 1 and never exceeds it", () => {
    expect(similarityWeight(0.9)).toBe(1);
    expect(similarityWeight(1)).toBe(1);
  });

  it("is monotonic in similarity", () => {
    const ws = VOYAGE_PARAPHRASE_SIMS.map(similarityWeight);
    for (let i = 1; i < ws.length; i++) expect(ws[i]).toBeGreaterThanOrEqual(ws[i - 1]);
  });
});

describe("rrfBaseScore", () => {
  it("lets a strong vector-only hit beat a lexical hit several ranks down", () => {
    // The paraphrase case in miniature: no lexical overlap at all (lexRank 0),
    // but the embedding put it first. It must not lose to mid-pack keyword noise.
    const vectorOnly = rrfBaseScore(0, 1, 0.562);
    const lexicalMidPack = rrfBaseScore(5, 0, undefined);
    expect(vectorOnly).toBeGreaterThan(lexicalMidPack);
  });

  it("does not penalise a hit for being absent from the other retriever", () => {
    // max() dominates, so an un-embedded corpus ranks exactly as it did before.
    expect(rrfBaseScore(1, 0, undefined)).toBeCloseTo(rrfTerm(1), 10);
  });

  it("rewards agreement between the two retrievers", () => {
    // Rank 3, not rank 1: at rank 1 both terms are already 1.0 and the [0,1]
    // clamp hides the consensus bonus entirely.
    const both = rrfBaseScore(3, 3, 0.9);
    const lexOnly = rrfBaseScore(3, 0, undefined);
    expect(both).toBeGreaterThan(lexOnly);
  });

  it("stays within [0, 1]", () => {
    for (const [l, v, s] of [[1, 1, 0.99], [0, 1, 0.5], [1, 0, undefined], [0, 0, undefined]] as const) {
      const out = rrfBaseScore(l, v, s);
      expect(out).toBeGreaterThanOrEqual(0);
      expect(out).toBeLessThanOrEqual(1);
    }
  });
});
