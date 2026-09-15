/** Watcher + single-session sync tests (new chats searchable within seconds). */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp, closeApp, type GatewayApp } from "../src/app.js";
import { syncSession, searchOnce, syncNow } from "../src/commands.js";
import { watchSources } from "../src/watch.js";
import type { VectorStore } from "../src/indexing/vectors.js";
import { embeddingsAvailable } from "../src/embeddings/provider.js";

const HAS_EMBEDDINGS = (await embeddingsAvailable()).available;

let app: GatewayApp;
let claudeDir: string;
let root: string;
const SID = "eeeeeeee-1111-2222-3333-444444444444";

function claudeLines(id: string, text: string): string {
  return [
    JSON.stringify({ type: "user", uuid: "u1", timestamp: "2026-09-10T10:00:00Z", sessionId: id, cwd: "/repo/cozea", message: { role: "user", content: text } }),
    JSON.stringify({ type: "assistant", uuid: "a1", timestamp: "2026-09-10T10:01:00Z", sessionId: id, cwd: "/repo/cozea", message: { role: "assistant", content: [{ type: "text", text: `Re: ${text} — hyperspace bypass calibration complete` }] } }),
  ].join("\n");
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "acg-watch-"));
  claudeDir = join(root, "claude");
  await mkdir(join(claudeDir, "cozea"), { recursive: true });
  app = createApp({ indexDir: join(root, "index"), claudeDir, codexDir: join(root, "empty-codex"), backend: "tantivy", cursorDb: join(root, "no-cursor.vscdb") });
});

afterAll(() => closeApp(app));

describe("syncSession", () => {
  it("indexes one session without a full sync", async () => {
    await writeFile(join(claudeDir, "cozea", `${SID}.jsonl`), claudeLines(SID, "Initial query about hyperspace"));
    const res = await syncSession(app, "claude-code", SID);
    expect(res.turns).toBe(2);
    const found = await searchOnce(app, "hyperspace bypass calibration");
    expect(found.results[0].provenance.sessionId).toBe(SID);
  });

  it("unknown session throws not_found", async () => {
    await expect(syncSession(app, "claude-code", "nope")).rejects.toThrow("not_found");
  });
});

describe("watchSources", () => {
  it("fires a sync shortly after a .jsonl write", async () => {
    const fired = new Promise<{ sessionsIndexed: number }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("watch did not fire")), 20000);
      const watchers = watchSources(app, {
        dirs: [claudeDir],
        debounceMs: 100,
        onSync: (r) => {
          clearTimeout(timer);
          for (const w of watchers) w.close();
          resolve(r);
        },
      });
    });
    const SID2 = "ffffffff-1111-2222-3333-444444444444";
    await writeFile(join(claudeDir, "cozea", `${SID2}.jsonl`), claudeLines(SID2, "watch-triggered zebracorn analysis"));
    const r = await fired;
    expect(r.sessionsIndexed).toBeGreaterThanOrEqual(1);
    const found = await searchOnce(app, "zebracorn");
    expect(found.results[0].provenance.sessionId).toBe(SID2);
  }, 30000);
});

describe.skipIf(!HAS_EMBEDDINGS)("watch --embed", () => {
  it("embeds only the sessions a sync touched", async () => {
    const seen: string[][] = [];
    const fake = {
      existing: async (ids: string[]) => {
        seen.push(ids);
        return new Set(ids); // everything already embedded: no model calls
      },
      upsert: async () => {},
      maybeOptimize: async () => {},
      optimize: async () => {},
      count: async () => 0,
    } as unknown as VectorStore;
    const prev = app.vectors;
    app.vectors = fake;
    try {
      const SID3 = "abababab-5555-6666-7777-888888888888";
      const fired = new Promise<{ embedded?: number }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("watch did not fire")), 20000);
        const watchers = watchSources(app, {
          dirs: [claudeDir],
          debounceMs: 100,
          embed: true,
          onSync: (r) => {
            clearTimeout(timer);
            for (const w of watchers) w.close();
            resolve(r);
          },
        });
      });
      await writeFile(join(claudeDir, "cozea", `${SID3}.jsonl`), claudeLines(SID3, "embedding scope check"));
      const r = await fired;
      expect(r.embedded).toBe(0);
      expect(seen).toHaveLength(1);
      expect(seen[0].every((id) => id.includes(SID3))).toBe(true);
    } finally {
      app.vectors = prev;
    }
  }, 30000);
});

describe("index writes are serialized", () => {
  it("a sync waits while another write holds the index lock", async () => {
    let release!: () => void;
    const held = app.indexLock.run(() => new Promise<void>((r) => (release = r)));
    let done = false;
    const pending = syncNow(app, false).then(() => {
      done = true;
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(done).toBe(false);
    release();
    await held;
    await pending;
    expect(done).toBe(true);
  });

  it("rebuild racing a sync and a session sync leaves a consistent index", async () => {
    const results = await Promise.all([syncNow(app, true), syncNow(app, false), syncSession(app, "claude-code", SID)]);
    expect(results).toHaveLength(3);
    const found = await searchOnce(app, "hyperspace bypass calibration");
    expect(found.results[0].provenance.sessionId).toBe(SID);
    const stats = app.index.stats();
    expect(Object.values(stats.perHarness).reduce((a, b) => a + b, 0)).toBe(stats.docCount);
  }, 30000);
});
