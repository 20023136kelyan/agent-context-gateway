/**
 * Trajectory adapter tests — read-only SWE-Gym/OpenHands-style fixtures.
 * All repos/issues are invented; no real trajectory data is used.
 */
import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { TrajectoryAdapter } from "../src/adapters/trajectories.js";

const FIXTURE_DIR = join(process.cwd(), "tests", "fixtures", "trajectories");

const byId = (sessions: { id: string }[]) => new Map(sessions.map((s) => [s.id, s]));

describe("TrajectoryAdapter", () => {
  it("lists 4 sessions with instance ids and repo-name projects", async () => {
    const a = new TrajectoryAdapter(FIXTURE_DIR);
    const sessions = await a.listSessions();
    expect(sessions).toHaveLength(4);
    const map = byId(sessions);
    expect([...map.keys()].sort()).toEqual(["cratesort-207", "scribe-312", "tidepool-101", "tiles-404"]);
    expect(map.get("tidepool-101")!.projectId).toBe("tidepool");
    expect(map.get("cratesort-207")!.projectId).toBe("cratesort");
    expect(map.get("scribe-312")!.projectId).toBe("scribe");
    expect(map.get("tiles-404")!.projectId).toBe("tiles");
    for (const s of sessions) {
      expect(s.agentId).toBe("trajectory:sessions");
      expect(s.sourcePath).toContain(FIXTURE_DIR);
      expect(s.startedAt).toBeTruthy();
    }
  });

  it("maps thought+action to assistant turns and observations to tool turns", async () => {
    const a = new TrajectoryAdapter(FIXTURE_DIR);
    const turns = await a.listTurns("tidepool-101");
    expect(turns.map((t) => t.role)).toEqual(["assistant", "tool", "assistant", "tool"]);
    expect(turns[0].content).toContain("src/player/queue.ts");
    expect(turns[0].content).toContain("Action: read src/player/queue.ts");
    expect(turns[1].content).toContain("no empty-list check");
    expect(turns[2].fileRefs).toContain("src/player/queue.ts");
    // seq ordering + provenance
    expect(turns.map((t) => t.seq)).toEqual([0, 1, 2, 3]);
    for (const t of turns) {
      expect(t.sessionId).toBe("tidepool-101");
      expect(t.timestamp).toBeTruthy();
    }
  });

  it("keeps tool names on multi-step tool-use trajectories", async () => {
    const a = new TrajectoryAdapter(FIXTURE_DIR);
    const turns = await a.listTurns("scribe-312");
    expect(turns).toHaveLength(6);
    const tools = turns.filter((t) => t.role === "tool");
    expect(tools.map((t) => t.toolNames?.[0])).toEqual(["read", "bash", "edit"]);
    expect(turns[0].content).toContain("buildTrigrams");
  });

  it("produces stable turn ids across reloads", async () => {
    const first = await new TrajectoryAdapter(FIXTURE_DIR).listTurns("cratesort-207");
    const second = await new TrajectoryAdapter(FIXTURE_DIR).listTurns("cratesort-207");
    expect(first.map((t) => t.id)).toEqual(second.map((t) => t.id));
    expect(first[0].id).toContain("cratesort-207");
    expect(new Set(first.map((t) => t.id)).size).toBe(first.length);
  });

  it("yields zero turns for the empty trajectory", async () => {
    const a = new TrajectoryAdapter(FIXTURE_DIR);
    expect(await a.listTurns("tiles-404")).toEqual([]);
  });

  it("yields zero sessions for a missing dir and never throws on file errors", async () => {
    const root = await mkdtemp(join(tmpdir(), "acg-traj-"));
    const a = new TrajectoryAdapter(join(root, "does-not-exist"));
    expect(await a.listSessions()).toEqual([]);
    expect(await a.listTurns("anything")).toEqual([]);
    expect(await a.getCursor()).toEqual({});
  });

  it("getTurn round-trips", async () => {
    const a = new TrajectoryAdapter(FIXTURE_DIR);
    const turns = await a.listTurns("scribe-312");
    const one = await a.getTurn("scribe-312", turns[4].id);
    expect(one.content).toBe(turns[4].content);
    await expect(a.getTurn("scribe-312", "codex:scribe-312:nope")).rejects.toThrow();
  });
});
