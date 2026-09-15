/**
 * Unit & Integration tests for Live Context Search & Context Subscriptions (Phase F).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ClaudeAdapter } from "../src/adapters/claude.js";
import {
  SubscriptionStore,
  searchLiveSessions,
} from "../src/collaboration/live.js";
import type { Turn } from "../src/core/models.js";

describe("SubscriptionStore", () => {
  let store: SubscriptionStore;

  beforeAll(async () => {
    const root = await mkdtemp(join(tmpdir(), "acg-subs-test-"));
    store = new SubscriptionStore(join(root, "subscriptions.json"));
  });

  it("subscribes and receives push notifications on matching turns", () => {
    const sub = store.subscribe("collaboration architecture");
    expect(sub.id).toBeTruthy();
    expect(sub.query).toBe("collaboration architecture");

    const turns: Turn[] = [
      {
        id: "t1",
        sessionId: "s1",
        harness: "claude-code",
        timestamp: new Date().toISOString(),
        role: "assistant",
        content: "We decided the collaboration architecture will use files as the shared primitive",
        raw: {},
        seq: 0,
      },
      {
        id: "t2",
        sessionId: "s2",
        harness: "claude-code",
        timestamp: new Date().toISOString(),
        role: "user",
        content: "What is for lunch today",
        raw: {},
        seq: 1,
      },
    ];

    const notifications = store.notifyTurns(turns);
    expect(notifications.length).toBe(1);
    expect(notifications[0].subscriptionId).toBe(sub.id);
    expect(notifications[0].matchingTurns.map((t) => t.id)).toEqual(["t1"]);
  });

  it("unsubscribes cleanly", () => {
    const sub = store.subscribe("temporary query");
    expect(store.unsubscribe(sub.id)).toBe(true);
    expect(store.unsubscribe(sub.id)).toBe(false);
  });
});

describe("searchLiveSessions", () => {
  let claudeDir: string;
  const ACTIVE_SESS = "live-session-active";

  beforeAll(async () => {
    const root = await mkdtemp(join(tmpdir(), "acg-live-test-"));
    claudeDir = join(root, "claude");
    await mkdir(join(claudeDir, "live-proj"), { recursive: true });

    // Write a fresh session file (mtime = now)
    await writeFile(
      join(claudeDir, "live-proj", `${ACTIVE_SESS}.jsonl`),
      [
        JSON.stringify({
          type: "user",
          uuid: "u1",
          timestamp: new Date().toISOString(),
          sessionId: ACTIVE_SESS,
          cwd: "/repo/live",
          message: { role: "user", content: "Active agent investigating memory leak in live pipeline" },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: "a1",
          timestamp: new Date().toISOString(),
          sessionId: ACTIVE_SESS,
          cwd: "/repo/live",
          message: { role: "assistant", content: "Identified heap growth in streaming buffer allocation" },
        }),
      ].join("\n"),
    );
  });

  it("searches currently active sessions from native history without prior index sync", async () => {
    const adapter = new ClaudeAdapter(claudeDir);
    const liveHits = await searchLiveSessions([adapter], "memory leak pipeline", {
      activeWindowMs: 5 * 60 * 1000,
    });

    expect(liveHits.length).toBe(1);
    expect(liveHits[0].session.id).toBe(ACTIVE_SESS);
    expect(liveHits[0].isLive).toBe(true);
    expect(liveHits[0].matchedTurns.length).toBeGreaterThanOrEqual(1);
    expect(liveHits[0].matchedTurns[0].content).toContain("memory leak");
  });
});
