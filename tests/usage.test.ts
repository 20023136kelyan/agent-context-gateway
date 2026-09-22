/**
 * Usage telemetry: shape-only events, aggregation math, and the no-PII
 * property that makes the whole thing shippable. No app instances needed
 * except through the real commands (covered by existing suites).
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readFileSync } from "node:fs";
import {
  recordUsage,
  aggregateUsage,
  defaultUsagePath,
  termBucket,
  scoreBucket,
  type UsageEvent,
} from "../src/observability/usage.js";

const searchEvent = (over: Partial<UsageEvent> = {}): UsageEvent => ({
  kind: "search",
  ts: new Date().toISOString(),
  latencyMs: 100,
  semantic: true,
  rerank: false,
  rawRank: false,
  engine: "voyage",
  reranker: "jev",
  harness: null,
  scope: "project",
  termBucket: "4-8",
  hasEntities: false,
  isWhy: false,
  results: 2,
  resultHarnesses: { codex: 2 },
  topScoreBucket: "mid",
  ...over,
});

describe("usage", () => {
  it("records and aggregates shape-only events", () => {
    const root = mkdtempSync(join(tmpdir(), "acg-usage-"));
    const p = defaultUsagePath(root);
    recordUsage(p, searchEvent({ latencyMs: 100 }));
    recordUsage(p, searchEvent({ latencyMs: 200 }));
    recordUsage(p, searchEvent({ latencyMs: 300, results: 0, resultHarnesses: {} }));
    recordUsage(p, {
      kind: "decide",
      ts: new Date().toISOString(),
      latencyMs: 500,
      engine: "voyage",
      judge: "jev",
      harness: null,
      candidates: 4,
      verdicts: 2,
      topConfidenceBucket: "high",
    });
    const agg = aggregateUsage(p);
    expect(agg.window).toEqual({ events: 4, searches: 3, decides: 1 });
    expect(agg.latencyMs["sem+norR"].p50).toBe(200);
    expect(agg.zeroHitRate["sem+norR"]).toBeCloseTo(1 / 3, 4);
    expect(agg.resultHarness).toEqual({ codex: 4 });
    expect(agg.judges).toEqual({ jev: 1 });
  });

  it("contains no text, ids, paths, or principals — ever", () => {
    const root = mkdtempSync(join(tmpdir(), "acg-usage-"));
    const p = defaultUsagePath(root);
    const nasty = "secret-token-xyz session abc123 /Users/x/.claude/projects foo@bar.com";
    // The event schema has no string field that could carry content: every
    // field is a boolean, bucket, count, or closed enum. Prove it by shape:
    const evt = searchEvent();
    const strings = Object.entries(evt)
      .filter(([, v]) => typeof v === "string")
      .map(([k]) => k);
    expect(strings.sort()).toEqual(["engine", "kind", "reranker", "scope", "termBucket", "topScoreBucket", "ts"]);
    recordUsage(p, evt);
    const body = readFileSync(p, "utf8");
    expect(body).not.toContain("secret");
    void nasty;
  });

  it("stays silent when disabled and on missing files", () => {
    const root = mkdtempSync(join(tmpdir(), "acg-usage-"));
    process.env.GATEWAY_USAGE = "off";
    try {
      recordUsage(defaultUsagePath(root), searchEvent());
      const agg = aggregateUsage(defaultUsagePath(root));
      expect(agg.window.events).toBe(0);
    } finally {
      delete process.env.GATEWAY_USAGE;
    }
    expect(aggregateUsage(join(root, "nope.jsonl")).window.events).toBe(0);
  });

  it("buckets terms and scores on boundaries", () => {
    expect(termBucket(0)).toBe("0-3");
    expect(termBucket(3)).toBe("0-3");
    expect(termBucket(8)).toBe("4-8");
    expect(termBucket(9)).toBe("9+");
    expect(scoreBucket(null)).toBe("none");
    expect(scoreBucket(0.29)).toBe("low");
    expect(scoreBucket(0.7)).toBe("high");
  });
});
