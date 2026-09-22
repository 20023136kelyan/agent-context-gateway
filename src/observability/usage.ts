/**
 * Shape-only usage telemetry for the engine improvement loop.
 *
 * WHAT is recorded per request: timing, arm flags, resolved components,
 * harness mix of request AND results, and boolean query features (length
 * bucket, entity presence, why-wording). WHAT IS NEVER recorded: query text,
 * session/turn ids, content, file paths, project names, principals, webhook
 * URLs. The improvement signal this buys is environmental — which arms serve
 * which harnesses at what latency with what hit rates — while quality itself
 * stays measured by golden evals, never by mining user queries.
 *
 * Local only: append-only JSONL under the state dir (`usage.jsonl`), capped
 * by row count. No network, no opt-out needed for local logging; any future
 * remote reporting ships aggregates alone behind an explicit flag (not built).
 * Disable entirely with GATEWAY_USAGE=off.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";

export function usageEnabled(): boolean {
  return process.env.GATEWAY_USAGE !== "off";
}

/** Rows per file before the oldest are compacted away. */
const MAX_ROWS = 20000;

export interface SearchUsageEvent {
  kind: "search";
  ts: string;
  latencyMs: number;
  /** Resolved request shape, not content. */
  semantic: boolean;
  rerank: boolean;
  rawRank: boolean;
  engine: string;
  reranker: string;
  harness: string | null;
  scope: string;
  /** Query shape features — booleans and buckets only. */
  termBucket: "0-3" | "4-8" | "9+";
  hasEntities: boolean;
  isWhy: boolean;
  /** Outcome shape. */
  results: number;
  resultHarnesses: Record<string, number>;
  topScoreBucket: "none" | "low" | "mid" | "high";
}

export interface DecideUsageEvent {
  kind: "decide";
  ts: string;
  latencyMs: number;
  engine: string;
  judge: string;
  harness: string | null;
  candidates: number;
  verdicts: number;
  topConfidenceBucket: "none" | "low" | "mid" | "high";
}

export type UsageEvent = SearchUsageEvent | DecideUsageEvent;

export function defaultUsagePath(stateDir?: string): string {
  const base = stateDir ?? process.env.CONTEXT_GATEWAY_STATE ?? `${process.env.HOME ?? "/tmp"}/.context-gateway`;
  return join(base, "usage.jsonl");
}

function bucketScore(score: number | null | undefined): "none" | "low" | "mid" | "high" {
  if (score === null || score === undefined) return "none";
  if (score < 0.3) return "low";
  if (score < 0.7) return "mid";
  return "high";
}

export function scoreBucket(score: number | null | undefined): "none" | "low" | "mid" | "high" {
  return bucketScore(score);
}

export function termBucket(terms: number): "0-3" | "4-8" | "9+" {
  if (terms <= 3) return "0-3";
  if (terms <= 8) return "4-8";
  return "9+";
}

export function recordUsage(path: string, event: UsageEvent): void {
  if (!usageEnabled()) return;
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(event) + "\n");
    void maybeCompact(path);
  } catch {
    // Telemetry never breaks serving.
  }
}

function maybeCompact(path: string): void {
  // Cheap gate: only scan when the file is plausibly over budget (~200B/row).
  try {
    if (statSync(path).size < MAX_ROWS * 200) return;
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    if (lines.length > MAX_ROWS) {
      writeFileSync(path, lines.slice(lines.length - MAX_ROWS).join("\n") + "\n");
    }
  } catch {
    // ignore
  }
}

export interface UsageAggregate {
  window: { events: number; searches: number; decides: number };
  latencyMs: Record<string, { p50: number; p95: number; n: number }>;
  /** Share of searches returning zero results, per arm key. */
  zeroHitRate: Record<string, number>;
  /** Which harnesses get queried vs what comes back. */
  requestedHarness: Record<string, number>;
  resultHarness: Record<string, number>;
  judges: Record<string, number>;
  engines: Record<string, number>;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

export function aggregateUsage(path: string): UsageAggregate {
  const agg: UsageAggregate = {
    window: { events: 0, searches: 0, decides: 0 },
    latencyMs: {},
    zeroHitRate: {},
    requestedHarness: {},
    resultHarness: {},
    judges: {},
    engines: {},
  };
  let raw = "";
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return agg;
  }
  const latByArm: Record<string, number[]> = {};
  const zeroByArm: Record<string, { zero: number; n: number }> = {};
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let e: UsageEvent;
    try {
      e = JSON.parse(line) as UsageEvent;
    } catch {
      continue;
    }
    agg.window.events++;
    if (e.kind === "search") {
      agg.window.searches++;
      const arm = `${e.semantic ? "sem" : "lex"}+${e.rerank ? "rr" : "norR"}${e.rawRank ? "+raw" : ""}`;
      (latByArm[arm] = latByArm[arm] ?? []).push(e.latencyMs);
      const z = (zeroByArm[arm] = zeroByArm[arm] ?? { zero: 0, n: 0 });
      z.n++;
      if (e.results === 0) z.zero++;
      agg.requestedHarness[e.harness ?? "all"] = (agg.requestedHarness[e.harness ?? "all"] ?? 0) + 1;
      for (const [h, n] of Object.entries(e.resultHarnesses)) {
        agg.resultHarness[h] = (agg.resultHarness[h] ?? 0) + n;
      }
      agg.engines[e.engine] = (agg.engines[e.engine] ?? 0) + 1;
    } else if (e.kind === "decide") {
      agg.window.decides++;
      agg.judges[e.judge] = (agg.judges[e.judge] ?? 0) + 1;
      agg.engines[e.engine] = (agg.engines[e.engine] ?? 0) + 1;
      (latByArm[`decide:${e.judge}`] = latByArm[`decide:${e.judge}`] ?? []).push(e.latencyMs);
    }
  }
  for (const [arm, lats] of Object.entries(latByArm)) {
    const sorted = [...lats].sort((a, b) => a - b);
    agg.latencyMs[arm] = { p50: percentile(sorted, 50), p95: percentile(sorted, 95), n: lats.length };
  }
  for (const [arm, z] of Object.entries(zeroByArm)) {
    agg.zeroHitRate[arm] = z.n > 0 ? Number((z.zero / z.n).toFixed(4)) : 0;
  }
  return agg;
}
