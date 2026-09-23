/**
 * Telemetry opt-in + aggregate-only reporting. The load-bearing assertions:
 * off by default through every path, and the payload physically cannot carry
 * per-request rows (it is built from the aggregate function, and the test
 * proves no query-shaped string survives).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  resolveSettings,
  setTelemetry,
  defaultStateDir,
} from "../src/settings.js";
import { buildReport, flushReport } from "../src/observability/report.js";
import { recordUsage } from "../src/observability/usage.js";

describe("telemetry", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    for (const k of Object.keys(process.env)) {
      if (!(k in saved)) delete process.env[k];
    }
    Object.assign(process.env, saved);
    process.env.CONTEXT_GATEWAY_STATE = mkdtempSync(join(tmpdir(), "acg-tel-"));
    delete process.env.GATEWAY_TELEMETRY;
  });
  afterEach(() => {
    for (const k of Object.keys(process.env)) {
      if (!(k in saved)) delete process.env[k];
    }
    Object.assign(process.env, saved);
  });

  it("defaults off with no env and no file", () => {
    expect(resolveSettings().telemetry).toBe(false);
  });

  it("env beats file in both directions", () => {
    setTelemetry(defaultStateDir(), true);
    expect(resolveSettings().telemetry).toBe(true);
    process.env.GATEWAY_TELEMETRY = "off";
    expect(resolveSettings().telemetry).toBe(false);
    delete process.env.GATEWAY_TELEMETRY;
    process.env.GATEWAY_TELEMETRY = "on";
    expect(resolveSettings().telemetry).toBe(true);
  });

  it("treats garbage as off", () => {
    process.env.GATEWAY_TELEMETRY = "maybe";
    expect(resolveSettings().telemetry).toBe(false);
  });

  it("report carries aggregates and env facts, never rows", async () => {
    const { defaultUsagePath } = await import("../src/observability/usage.js");
    recordUsage(defaultUsagePath(defaultStateDir()), {
      kind: "search",
      ts: new Date().toISOString(),
      latencyMs: 50,
      semantic: true,
      rerank: false,
      rawRank: false,
      engine: "voyage",
      reranker: "jev",
      harness: null,
      scope: "project",
      termBucket: "4-8",
      hasEntities: false,
      isWhy: true,
      results: 1,
      resultHarnesses: { codex: 1 },
      topScoreBucket: "high",
    });
    const report = buildReport(defaultStateDir(), { backend: "tantivy", engine: "voyage", reranker: "jev", judge: "jev" });
    expect(report.usage.window.searches).toBe(1);
    expect(report.env.engine).toBe("voyage");
    const body = JSON.stringify(report);
    // No per-request surface exists to leak: prove the payload has no rows,
    // no query text slot, no id slot of any kind.
    expect(body).not.toContain("results");
    expect(body).not.toMatch(/sessionId|turnId|query|content|path|principal/i);
  });

  it("flush posts JSON and fails silent", async () => {
    const f = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", f);
    try {
      const report = buildReport(defaultStateDir(), {});
      expect(await flushReport(report, "https://example.invalid/r")).toBe(true);
      const sent = JSON.parse((f.mock.calls[0][1] as { body: string }).body);
      expect(sent.usage.window.events).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("down"); }));
    try {
      expect(await flushReport(buildReport(defaultStateDir(), {}), "https://example.invalid/r")).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("telemetry endpoint", () => {
  // There is no built-in endpoint: the old default was a domain nobody here
  // controls, which would have received every opted-in user's report.
  it("sends nothing, and never calls fetch, when no endpoint is configured", async () => {
    const saved = process.env.GATEWAY_TELEMETRY_URL;
    delete process.env.GATEWAY_TELEMETRY_URL;
    const realFetch = globalThis.fetch;
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    try {
      expect(await flushReport(buildReport(undefined, {}))).toBe(false);
      expect(called).toBe(false);
    } finally {
      globalThis.fetch = realFetch;
      if (saved !== undefined) process.env.GATEWAY_TELEMETRY_URL = saved;
    }
  });
});
