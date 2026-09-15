/**
 * Unit and integration tests for Evaluation Metrics and the Golden Harness.
 */
import { describe, it, expect } from "vitest";
import { ndcgAtK, mrrAtK, precisionAtK, evaluateCitations } from "../src/eval/metrics.js";
import { loadGoldenQueries } from "../src/eval/runner.js";

describe("IR Metrics", () => {
  it("computes perfect NDCG@5 when all top results are relevant", () => {
    const ranked = ["doc1", "doc2", "doc3", "doc4", "doc5"];
    const relevant = ["doc1", "doc2", "doc3"];
    const score = ndcgAtK(ranked, relevant, 5);
    expect(score).toBeCloseTo(1.0, 4);
  });

  it("computes lower NDCG@5 when relevant results appear later", () => {
    const perfect = ndcgAtK(["doc1", "doc2", "other1", "other2"], ["doc1", "doc2"], 5);
    const delayed = ndcgAtK(["other1", "other2", "doc1", "doc2"], ["doc1", "doc2"], 5);
    expect(delayed).toBeLessThan(perfect);
    expect(delayed).toBeGreaterThan(0);
  });

  it("computes MRR@5 accurately based on first relevant rank", () => {
    expect(mrrAtK(["rel", "other"], ["rel"], 5)).toBe(1.0);
    expect(mrrAtK(["other", "rel"], ["rel"], 5)).toBe(0.5);
    expect(mrrAtK(["other1", "other2", "rel"], ["rel"], 5)).toBeCloseTo(1 / 3, 4);
    expect(mrrAtK(["other1", "other2"], ["rel"], 5)).toBe(0.0);
  });

  it("computes precision@5 correctly", () => {
    expect(precisionAtK(["r1", "r2", "o1", "o2", "o3"], ["r1", "r2"], 5)).toBe(2 / 5);
  });

  it("evaluates citation precision and recall (ALCE framework)", () => {
    const citations = ["sessA", "sessA", "sessB", "sessIrrelevant"];
    const groundTruth = ["sessA", "sessB", "sessC"];
    const { citationPrecision, citationRecall } = evaluateCitations(citations, groundTruth);
    // 3 valid citations out of 4 total citations
    expect(citationPrecision).toBe(3 / 4);
    // 2 unique relevant sessions cited out of 3 total ground truth sessions
    expect(citationRecall).toBe(2 / 3);
  });
});

describe("Golden Query Benchmark Corpus", () => {
  it("loads 24 stratified golden queries with domain balance", () => {
    const queries = loadGoldenQueries();
    expect(queries.length).toBe(24);

    const domains = queries.map((q) => q.domain);
    const codeCount = domains.filter((d) => d === "code").length;
    const proseCount = domains.filter((d) => d === "prose").length;
    const paraCount = domains.filter((d) => d === "paraphrase").length;

    expect(codeCount).toBe(8);
    expect(proseCount).toBe(8);
    expect(paraCount).toBe(8);

    for (const q of queries) {
      expect(q.id).toBeTruthy();
      expect(q.query.trim().length).toBeGreaterThan(0);
      expect(q.relevantSessionIds.length).toBeGreaterThan(0);
    }
  });
});
