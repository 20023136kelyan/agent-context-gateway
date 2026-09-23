/**
 * Context-only turns (Turn.searchable = false): a Codex shell call is shown
 * around results and feeds the action index, but is never a retrieval
 * candidate. Indexed with its real command text it crowded the ranking
 * (hybrid -0.026 NDCG@5 on real history).
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, closeApp } from "../src/app.js";
import { syncNow, createSubscription } from "../src/commands.js";
import { embedSessionTurns } from "../src/indexing/embed-sync.js";
import type { VectorBackend } from "../src/indexing/vectors.js";

describe("context-only turns", () => {
  it("stay in the adapter's output but are never indexed, embedded, or re-notified", async () => {
    const root = mkdtempSync(join(tmpdir(), "acg-searchable-"));
    const day = join(root, "codex", "2026", "09", "01");
    mkdirSync(day, { recursive: true });
    writeFileSync(
      join(day, "rollout-s.jsonl"),
      [
        { timestamp: "2026-09-01T09:00:00Z", type: "session_meta", payload: { id: "cx1", cwd: "/repo" } },
        { timestamp: "2026-09-01T09:00:01Z", type: "response_item", payload: { type: "message", id: "m1", role: "user", content: [{ type: "input_text", text: "Run the database migration" }] } },
        { timestamp: "2026-09-01T09:00:02Z", type: "response_item", payload: { type: "function_call", id: "f1", name: "shell", arguments: JSON.stringify({ command: ["npm", "run", "db:migrate"] }), call_id: "c1" } },
      ].map((l) => JSON.stringify(l)).join("\n"),
    );
    const dead = (n: string) => {
      const d = join(root, n);
      mkdirSync(d, { recursive: true });
      return d;
    };
    const saved = process.env.CONTEXT_GATEWAY_STATE;
    process.env.CONTEXT_GATEWAY_STATE = join(root, "state");
    const app = createApp({
      claudeDir: dead("claude"), codexDir: join(root, "codex"), indexDir: join(root, "index"),
      cursorDb: dead("cursor"), zepDir: dead("zep"), opencodeDb: dead("opencode"), trajectoryDir: dead("traj"), gitRepos: [],
    });
    try {
      const adapter = app.adapters.find((a) => a.harness === "codex")!;
      const turns = await adapter.listTurns("cx1");
      const call = turns.find((t) => t.content.startsWith("shell("))!;
      expect(call.searchable).toBe(false);

      await syncNow(app);
      expect(app.index.existingIds(turns.map((t) => t.id))).toEqual(new Set(turns.filter((t) => t !== call).map((t) => t.id)));

      // A context-only turn is never in the index, so it must not count as
      // "new": otherwise every re-sync of its session would re-notify it.
      createSubscription(app, "db migrate");
      appendFileSync(
        join(day, "rollout-s.jsonl"),
        "\n" + JSON.stringify({ timestamp: "2026-09-01T09:05:00Z", type: "response_item", payload: { type: "message", id: "m2", role: "assistant", content: [{ type: "output_text", text: "db migrate finished cleanly" }] } }),
      );
      await syncNow(app);
      const notified = app.subscriptions.all()[0].recent?.flatMap((n) => n.turns.map((x) => x.turnId)) ?? [];
      expect(notified).not.toContain(call.id);
      expect(notified).toHaveLength(1);

      const embedded: string[] = [];
      const store = {
        existing: async () => new Set<string>(),
        upsert: async (rows: { id: string }[]) => void embedded.push(...rows.map((r) => r.id)),
        maybeOptimize: async () => undefined,
      } as unknown as VectorBackend;
      const saved = process.env.VOYAGE_API_KEY;
      process.env.VOYAGE_API_KEY = "k";
      const realFetch = globalThis.fetch;
      globalThis.fetch = (async (_u: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as { input: string[] };
        return new Response(JSON.stringify({ data: body.input.map((_s, index) => ({ index, embedding: new Array(1024).fill(0) })) }), { status: 200 });
      }) as typeof fetch;
      try {
        const session = (await adapter.listSessions())[0];
        await embedSessionTurns(adapter, session, store, 64, "voyage");
      } finally {
        globalThis.fetch = realFetch;
        if (saved === undefined) delete process.env.VOYAGE_API_KEY;
        else process.env.VOYAGE_API_KEY = saved;
      }
      expect(embedded.some((id) => id.startsWith(call.id))).toBe(false);
      expect(embedded.length).toBeGreaterThan(0);
    } finally {
      closeApp(app);
      if (saved === undefined) delete process.env.CONTEXT_GATEWAY_STATE;
      else process.env.CONTEXT_GATEWAY_STATE = saved;
    }
  });
});
