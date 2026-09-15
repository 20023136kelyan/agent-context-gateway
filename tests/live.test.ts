/**
 * Unit & Integration tests for Live Context Search & Context Subscriptions (Phase F).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { ClaudeAdapter } from "../src/adapters/claude.js";
import { createApp, closeApp, type GatewayApp } from "../src/app.js";
import { syncNow, createSubscription, listSubscriptions } from "../src/commands.js";
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

async function webhookServer(): Promise<{ url: string; received: Record<string, unknown>[]; close: () => Promise<void> }> {
  const received: Record<string, unknown>[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push(JSON.parse(body));
      res.writeHead(204).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/notify`, received, close: () => new Promise((r) => server.close(() => r())) };
}

const mkTurn = (id: string, content: string): Turn => ({
  id, sessionId: "s", harness: "claude-code", timestamp: new Date().toISOString(), role: "assistant", content, raw: {}, seq: 0,
});

const claudeLine = (sid: string, uuid: string, text: string) =>
  JSON.stringify({ type: "user", uuid, timestamp: "2026-09-10T10:00:00Z", sessionId: sid, cwd: "/repo/p", message: { role: "user", content: text } });

describe("subscription matching and delivery", () => {
  let store: SubscriptionStore;

  beforeAll(async () => {
    store = new SubscriptionStore(join(await mkdtemp(join(tmpdir(), "acg-subs-deliver-")), "subscriptions.json"));
  });

  it("rejects webhook URLs that aren't http(s)", () => {
    expect(() => store.subscribe("zebracorn", { webhookUrl: "file:///etc/passwd" })).toThrow("bad_request");
    expect(() => store.subscribe("zebracorn", { webhookUrl: "not a url" })).toThrow("bad_request");
  });

  it("matches on query terms, ignoring stop-words", () => {
    const sub = store.subscribe("what did they say about quasar pipelines");
    const notes = store.notifyTurns([mkTurn("q1", "The quasar pipelines say hello"), mkTurn("q2", "unrelated")]);
    expect(notes.find((n) => n.subscriptionId === sub.id)?.matchingTurns.map((t) => t.id)).toEqual(["q1"]);
    store.unsubscribe(sub.id);
  });

  it("POSTs matches to the webhook and records the outcome", async () => {
    const hook = await webhookServer();
    try {
      const sub = store.subscribe("webhook zebracorn", { webhookUrl: hook.url });
      const notes = store.notifyTurns([mkTurn("z1", "the zebracorn webhook fired")]);
      await store.deliver(notes);
      expect(hook.received).toHaveLength(1);
      expect(hook.received[0]).toMatchObject({ subscriptionId: sub.id, turns: [{ id: "z1" }] });
      expect(store.all().find((s) => s.id === sub.id)?.recent?.at(-1)?.webhook).toEqual({ ok: true, status: 204 });
    } finally {
      await hook.close();
    }
  });
});

describe("subscriptions fire on sync", () => {
  let app: GatewayApp;
  let claudeDir: string;
  let prevState: string | undefined;

  beforeAll(async () => {
    prevState = process.env.CONTEXT_GATEWAY_STATE;
    const root = await mkdtemp(join(tmpdir(), "acg-subs-sync-"));
    process.env.CONTEXT_GATEWAY_STATE = join(root, "state");
    claudeDir = join(root, "claude");
    await mkdir(join(claudeDir, "p"), { recursive: true });
    await writeFile(join(claudeDir, "p", "old-session.jsonl"), claudeLine("old-session", "u1", "narwhal migration was discussed long ago"));
    app = createApp({ indexDir: join(root, "index"), claudeDir, codexDir: join(root, "empty"), backend: "tantivy", cursorDb: join(root, "no.vscdb") });
    await syncNow(app);
  });

  afterAll(() => {
    closeApp(app);
    if (prevState === undefined) delete process.env.CONTEXT_GATEWAY_STATE;
    else process.env.CONTEXT_GATEWAY_STATE = prevState;
  });

  it("notifies once for turns new to the index, never for re-indexed history", async () => {
    const hook = await webhookServer();
    try {
      createSubscription(app, "narwhal migration", { webhookUrl: hook.url });
      const file = join(claudeDir, "p", "new-session.jsonl");
      await writeFile(file, claudeLine("new-session", "u1", "narwhal migration plan approved"));
      await syncNow(app);
      expect(hook.received).toHaveLength(1);
      expect((hook.received[0].turns as { id: string }[]).map((t) => t.id)).toEqual(["claude-code:new-session:u1"]);
      // Appending re-indexes the whole session; its old matching turn isn't new.
      await appendFile(file, "\n" + claudeLine("new-session", "u2", "lunch order placed"));
      await syncNow(app);
      expect(hook.received).toHaveLength(1);
      expect(listSubscriptions(app)[0].recent?.[0].webhook?.ok).toBe(true);
    } finally {
      await hook.close();
    }
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
