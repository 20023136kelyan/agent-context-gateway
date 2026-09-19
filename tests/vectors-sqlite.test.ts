import { describe, it, expect } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteVectorStore } from "../src/indexing/vectors-sqlite.js";
import { embedChunkId } from "../src/core/id.js";

const dir = async (tag: string) => join(await mkdtemp(join(tmpdir(), `acg-sqlitevec-${tag}-`)), "v");
const row = (id: string, vector: number[], over: Partial<{ harness: string; sessionId: string; projectId: string; timestampMs: number }> = {}) => ({
  id, vector, harness: "claude-code", sessionId: "s1", projectId: "p", timestampMs: 1000, ...over,
});

describe("SqliteVectorStore", () => {
  it("round-trips an upsert and ranks by cosine similarity", async () => {
    const store = await SqliteVectorStore.open(await dir("rt"));
    await store.upsert([row("a", [1, 0, 0]), row("b", [0, 1, 0])], "mlx");
    expect(await store.count()).toBe(2);
    const hits = await store.nearest([0, 1, 0], "mlx", 10);
    expect(hits[0].turnId).toBe("b");
    expect(hits[0].similarity).toBeCloseTo(1, 5);
    await store.close();
  });

  it("keeps two engines of the SAME width in separate tables", async () => {
    // The bug this backend was written for: keying storage on dimension alone
    // puts Ollama and a 1024-dim Voyage model in one table, where every
    // similarity silently compares across two unrelated embedding spaces.
    const store = await SqliteVectorStore.open(await dir("engines"));
    await store.upsert([row("shared-id", [1, 0, 0])], "ollama");
    await store.upsert([row("shared-id", [0, 0, 1])], "voyage");

    expect(await store.count()).toBe(2); // one row per engine, not one overwritten row
    const fromOllama = await store.nearest([1, 0, 0], "ollama", 5);
    const fromVoyage = await store.nearest([1, 0, 0], "voyage", 5);
    expect(fromOllama[0].similarity).toBeCloseTo(1, 5);   // its own space
    expect(fromVoyage[0].similarity).toBeCloseTo(0, 5);   // orthogonal in the other
    await store.close();
  });

  it("returns nothing for an engine that has never written", async () => {
    const store = await SqliteVectorStore.open(await dir("empty"));
    await store.upsert([row("a", [1, 0, 0])], "mlx");
    expect(await store.nearest([1, 0, 0], "voyage", 5)).toEqual([]);
    expect((await store.existing(["a"], "voyage")).size).toBe(0);
    await store.close();
  });

  it("bounds asOf inside the query, so newer turns cannot consume candidate slots", async () => {
    // Regression for 51ef1f7: applied after the search, `limit` had already
    // been spent on rows the filter then discarded, so the same asOf returned
    // fewer results as the corpus grew.
    const store = await SqliteVectorStore.open(await dir("asof"));
    const rows = [];
    for (let i = 0; i < 60; i++) {
      rows.push(row(`new-${i}`, [0, 1, 0], { timestampMs: 9_000_000 + i })); // newer, near-perfect match
    }
    rows.push(row("old-match", [0, 1, 0], { timestampMs: 1_000 })); // older, equally good
    await store.upsert(rows, "mlx");

    const bounded = await store.nearest([0, 1, 0], "mlx", 5, { maxTimestampMs: 5_000 });
    expect(bounded.map((h) => h.turnId)).toEqual(["old-match"]); // reachable despite 60 newer rows
    await store.close();
  });

  it("filters by harness and session inside the same query", async () => {
    const store = await SqliteVectorStore.open(await dir("filter"));
    await store.upsert([
      row("c1", [0, 1, 0], { harness: "claude-code", sessionId: "s1" }),
      row("x1", [0, 1, 0], { harness: "codex", sessionId: "s2" }),
    ], "mlx");
    expect((await store.nearest([0, 1, 0], "mlx", 5, { harness: "codex" })).map((h) => h.turnId)).toEqual(["x1"]);
    expect((await store.nearest([0, 1, 0], "mlx", 5, { sessionId: "s1" })).map((h) => h.turnId)).toEqual(["c1"]);
    await store.close();
  });

  it("collapses a turn's windows into one hit, scored by its best window", async () => {
    const store = await SqliteVectorStore.open(await dir("chunk"));
    const turn = "claude-code:s1:u-1";
    await store.upsert([
      row(embedChunkId(turn, 0), [1, 0, 0]), // head, unrelated to the query
      row(embedChunkId(turn, 1), [0, 1, 0]), // tail, which answers it
      row("claude-code:s1:u-2", [0, 0, 1]),
    ], "mlx");
    const hits = await store.nearest([0, 1, 0], "mlx", 10);
    const mine = hits.filter((h) => h.turnId === turn);
    expect(mine).toHaveLength(1);                      // one hit per turn, not per window
    expect(mine[0].similarity).toBeCloseTo(1, 5);      // best window, not the head and not a mean
    expect(hits.map((h) => h.turnId)).toContain("claude-code:s1:u-2");
    await store.close();
  });

  it("replaces a row by id rather than duplicating it", async () => {
    // vec0 implements neither ON CONFLICT nor INSERT OR REPLACE, and Claude
    // reuses turn uuids inside one file, so a batch can carry an id twice.
    const store = await SqliteVectorStore.open(await dir("dup"));
    await store.upsert([row("dup", [1, 0, 0]), row("other", [0, 1, 0]), row("dup", [0, 0, 1])], "mlx");
    expect(await store.count()).toBe(2);
    await store.upsert([row("dup", [0, 1, 0])], "mlx"); // now matching an existing row
    expect(await store.count()).toBe(2);
    expect([...(await store.existing(["dup", "other", "missing"], "mlx"))].sort()).toEqual(["dup", "other"]);
    await store.close();
  });

  it("reopens an existing store and finds what a previous session wrote", async () => {
    const d = await dir("reopen");
    const first = await SqliteVectorStore.open(d);
    await first.upsert([row("a", [1, 0, 0])], "mlx");
    await first.close();
    const second = await SqliteVectorStore.open(d);
    expect(await second.count()).toBe(1);                       // table discovered, not recreated
    expect((await second.nearest([1, 0, 0], "mlx", 5))[0].turnId).toBe("a");
    await second.close();
  });
});
