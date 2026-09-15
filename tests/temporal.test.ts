/**
 * Unit & integration tests for Phase C.1 Bi-temporal Invalidation Markers.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TemporalStore } from "../src/temporal/bi-temporal.js";
import { createApp, closeApp, type GatewayApp } from "../src/app.js";
import { searchOnce } from "../src/commands.js";
import { syncAll } from "../src/indexing/sync.js";
import { CursorStore } from "../src/indexing/store.js";
import type { Turn } from "../src/core/models.js";

describe("TemporalStore", () => {
  let store: TemporalStore;

  beforeAll(async () => {
    const root = await mkdtemp(join(tmpdir(), "acg-temp-test-"));
    store = new TemporalStore(join(root, "invalidations.jsonl"));
  });

  it("records and detects invalidation edges non-destructively", () => {
    const rec = store.recordInvalidation({
      supersededTurnId: "turn-monaco-1",
      supersedingTurnId: "turn-codemirror-2",
      reason: "Replaced Monaco with CodeMirror for licensing reasons",
      supersededAt: "2026-09-10T12:00:00Z",
      sourceSessionId: "sess-2",
    });

    expect(rec.id).toContain("turn-monaco-1");
    expect(store.isSuperseded("turn-monaco-1")).toBe(true);
    expect(store.isSuperseded("turn-codemirror-2")).toBe(false);
  });

  it("supports point-in-time reconstruction (asOf timestamp)", () => {
    // Before 2026-09-10, the invalidation had not happened yet -> turn was still valid!
    expect(store.isSuperseded("turn-monaco-1", "2026-09-01T00:00:00Z")).toBe(false);
    // After 2026-09-10, the invalidation is active -> turn is superseded!
    expect(store.isSuperseded("turn-monaco-1", "2026-09-15T00:00:00Z")).toBe(true);
  });

  it("automatically derives supersessions from turn dialogue cues", () => {
    const turns: Turn[] = [
      {
        id: "turn-old-arch",
        sessionId: "s1",
        harness: "codex",
        timestamp: "2026-08-01T10:00:00Z",
        role: "assistant",
        content: "We decided to adopt Kafka for all messaging queues across the system",
        raw: {},
        seq: 0,
      },
      {
        id: "turn-new-arch",
        sessionId: "s2",
        harness: "codex",
        timestamp: "2026-09-01T10:00:00Z",
        role: "assistant",
        content: "We decided to replace Kafka with NATS because Kafka operations are too heavy",
        raw: {},
        seq: 1,
      },
    ];

    const derived = store.deriveFromTurns(turns);
    expect(derived.length).toBe(1);
    expect(derived[0].supersededTurnId).toBe("turn-old-arch");
    expect(derived[0].supersedingTurnId).toBe("turn-new-arch");
    expect(store.isSuperseded("turn-old-arch")).toBe(true);
  });

  it("skips determiners when deriving the target ('replaced the …' doesn't target 'the')", async () => {
    const fresh = new TemporalStore(join(await mkdtemp(join(tmpdir(), "acg-temp-det-")), "invalidations.jsonl"));
    const turns: Turn[] = [
      { id: "old-1", sessionId: "s1", harness: "codex", timestamp: "2026-08-01T10:00:00Z", role: "assistant", content: "We use the new build system for the app", raw: {}, seq: 0 },
      { id: "new-1", sessionId: "s2", harness: "codex", timestamp: "2026-09-01T10:00:00Z", role: "assistant", content: "We replaced the editor widget with a lighter one", raw: {}, seq: 1 },
    ];
    expect(fresh.deriveFromTurns(turns)).toEqual([]);
  });
});

describe("search with bi-temporal invalidation", () => {
  let app: GatewayApp;
  let prevState: string | undefined;

  beforeAll(async () => {
    prevState = process.env.CONTEXT_GATEWAY_STATE;
    const root = await mkdtemp(join(tmpdir(), "acg-bitemp-"));
    process.env.CONTEXT_GATEWAY_STATE = join(root, "state");

    const claudeDir = join(root, "claude");
    await mkdir(join(claudeDir, "s"), { recursive: true });

    // Session 1: Old decision (August 2026)
    await writeFile(
      join(claudeDir, "s", "s1.jsonl"),
      JSON.stringify({
        type: "assistant",
        uuid: "u-old-monaco",
        timestamp: "2026-08-01T10:00:00Z",
        sessionId: "s1",
        cwd: "/repo/cozea",
        message: { role: "assistant", content: "We agreed to use Monaco editor for code rendering" },
      }),
    );

    // Session 2: New decision (September 2026)
    await writeFile(
      join(claudeDir, "s", "s2.jsonl"),
      JSON.stringify({
        type: "assistant",
        uuid: "u-new-codemirror",
        timestamp: "2026-09-10T10:00:00Z",
        sessionId: "s2",
        cwd: "/repo/cozea",
        message: { role: "assistant", content: "We decided to replace Monaco editor with CodeMirror" },
      }),
    );

    app = createApp({
      indexDir: join(root, "index"),
      claudeDir,
      codexDir: join(root, "empty"),
      backend: "tantivy",
      cursorDb: join(root, "no.vscdb"),
    });

    await syncAll(app.adapters, app.index, new CursorStore(join(root, "index")));

    // Record invalidation: new turn supersedes old turn
    app.temporal.recordInvalidation({
      supersededTurnId: "claude-code:s1:u-old-monaco",
      supersedingTurnId: "claude-code:s2:u-new-codemirror",
      reason: "Replaced Monaco with CodeMirror",
      supersededAt: "2026-09-10T10:00:00Z",
      sourceSessionId: "s2",
    });
  });

  afterAll(() => {
    closeApp(app);
    if (prevState === undefined) delete process.env.CONTEXT_GATEWAY_STATE;
    else process.env.CONTEXT_GATEWAY_STATE = prevState;
  });

  it("current search ranks active knowledge above superseded knowledge", async () => {
    const res = await searchOnce(app, "Monaco editor code");
    expect(res.results.length).toBeGreaterThanOrEqual(1);
    // The active turn (s2) should be #1
    expect(res.results[0].provenance.sessionId).toBe("s2");
    expect(res.results[0].isSuperseded).toBe(false);

    // The superseded turn should be flagged if present
    const old = res.results.find((r) => r.provenance.sessionId === "s1");
    if (old) {
      expect(old.isSuperseded).toBe(true);
      expect(old.invalidation).toBeDefined();
    }
  });

  it("point-in-time query asOf August 2026 reconstructs past belief without demotion", async () => {
    // As of August 15, Monaco had not been superseded yet!
    const res = await searchOnce(app, "Monaco editor code", { asOf: "2026-08-15T00:00:00Z" });
    expect(res.results.length).toBeGreaterThanOrEqual(1);
    const old = res.results.find((r) => r.provenance.sessionId === "s1");
    expect(old).toBeDefined();
    expect(old?.isSuperseded).toBe(false);
  });

  it("asOf also excludes turns written after that instant", async () => {
    const res = await searchOnce(app, "Monaco editor code", { asOf: "2026-08-15T00:00:00Z" });
    expect(res.results.some((r) => r.provenance.sessionId === "s2")).toBe(false);
    await expect(searchOnce(app, "Monaco", { asOf: "not a date" })).rejects.toThrow("bad_request");
  });
});
