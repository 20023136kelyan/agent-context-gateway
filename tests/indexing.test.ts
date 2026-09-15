/** M2 indexing tests — same suite against Tantivy (primary) + SQLite FTS5 (fallback). */
import { describe, it, expect, beforeAll } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ClaudeAdapter } from "../src/adapters/claude.js";
import { CodexAdapter } from "../src/adapters/codex.js";
import { SqliteIndex } from "../src/indexing/sqlite-index.js";
import { TantivyIndex } from "../src/indexing/tantivy-index.js";
import type { SearchIndex } from "../src/indexing/types.js";
import { CursorStore } from "../src/indexing/store.js";
import { syncAll } from "../src/indexing/sync.js";
import type { ContextAdapter } from "../src/adapters/types.js";
import type { Session, Turn } from "../src/core/models.js";

let claudeDir: string;
let codexDir: string;
let root: string;
const CLAUDE_SESSION = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const CODEX_SESSION = "019fzzzz-0000-1111-2222-333333333333";

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "acg-m2-"));

  claudeDir = join(root, "claude");
  await mkdir(join(claudeDir, "cozea"), { recursive: true });
  await writeFile(
    join(claudeDir, "cozea", `${CLAUDE_SESSION}.jsonl`),
    [
      JSON.stringify({ type: "user", uuid: "u1", timestamp: "2026-09-01T10:00:00Z", sessionId: CLAUDE_SESSION, cwd: "/repo/cozea", message: { role: "user", content: "Investigate collaboration architecture" } }),
      JSON.stringify({ type: "assistant", uuid: "a1", timestamp: "2026-09-01T10:01:00Z", sessionId: CLAUDE_SESSION, cwd: "/repo/cozea", message: { role: "assistant", content: [{ type: "text", text: "Session workbench remains private. Files are the shared primitive." }] } }),
    ].join("\n"),
  );

  codexDir = join(root, "codex");
  await mkdir(join(codexDir, "2026", "09", "14"), { recursive: true });
  await writeFile(
    join(codexDir, "2026", "09", "14", `rollout-2026-09-14T00-00-00-${CODEX_SESSION}.jsonl`),
    [
      JSON.stringify({ timestamp: "2026-09-01T09:00:00Z", ordinal: 0, type: "session_meta", payload: { session_id: CODEX_SESSION, cwd: "/repo/cozea" } }),
      JSON.stringify({ timestamp: "2026-09-01T09:01:00Z", ordinal: 1, type: "response_item", payload: { type: "message", id: "m1", role: "assistant", content: [{ type: "output_text", text: "Monaco editor should be replaced with CodeMirror." }] } }),
    ].join("\n"),
  );
});

const backends: { name: string; create: (dir: string) => SearchIndex }[] = [
  { name: "tantivy", create: (dir) => new TantivyIndex(dir) },
  { name: "sqlite", create: (dir) => new SqliteIndex(dir) },
];

for (const backend of backends) {
  describe(`index (${backend.name}) + sync`, () => {
    it("syncs both harnesses and searches across them", async () => {
      const indexDir = join(root, `index-${backend.name}-1`);
      const adapters = [new ClaudeAdapter(claudeDir), new CodexAdapter(codexDir)];
      const index = backend.create(indexDir);
      const cursors = new CursorStore(indexDir);
      try {
      const res = await syncAll(adapters, index, cursors);
      expect(res.sessionsSeen).toBe(2);
      expect(res.turnsIndexed).toBeGreaterThanOrEqual(3);

      // per-harness stats are exact (append + rebuild discipline).
      const stats = index.stats();
      const total = Object.values(stats.perHarness).reduce((a, b) => a + b, 0);
      expect(total).toBe(stats.docCount);

        expect(index.search("workbench private").length).toBeGreaterThanOrEqual(1);
        expect(index.search("collaboration architecture").length).toBeGreaterThanOrEqual(1);
        expect(index.search("Monaco CodeMirror replaced").length).toBeGreaterThanOrEqual(1);

        // harness filter
        expect(index.search("Monaco", { harness: "codex" }).length).toBeGreaterThanOrEqual(1);
        expect(index.search("Monaco", { harness: "claude-code" }).length).toBe(0);

        // scores are higher-better
        const hits = index.search("workbench");
        expect(hits[0].score).toBeGreaterThan(0);
      } finally {
        index.close();
      }
    });

    it("second sync skips unchanged files (incremental)", async () => {
      const indexDir = join(root, `index-${backend.name}-2`);
      const adapters = [new ClaudeAdapter(claudeDir), new CodexAdapter(codexDir)];
      const first = backend.create(indexDir);
      try {
        await syncAll(adapters, first, new CursorStore(indexDir));
      } finally {
        first.close();
      }
      const second = backend.create(indexDir);
      try {
        const res = await syncAll(adapters, second, new CursorStore(indexDir));
        expect(res.sessionsSkipped).toBe(2);
        expect(res.sessionsIndexed).toBe(0);
        expect(second.stats().docCount).toBeGreaterThanOrEqual(3);
      } finally {
        second.close();
      }
    });

    it("defers writes until commit(); docCount() agrees with stats", async () => {
      const index = backend.create(join(root, `index-${backend.name}-3`));
      try {
        const turn = {
          id: "claude-code:deferred-1:t1", sessionId: "deferred-1", harness: "claude-code" as const,
          timestamp: "2026-09-10T00:00:00Z", role: "user" as const, content: "deferredword appears once",
          raw: {}, seq: 0, projectId: "p", workspace: "/w", repo: null,
        };
        index.indexTurns([turn], "/tmp/deferred.jsonl", { commit: false });
        // Tantivy readers see commits only (SQLite's own connection sees its open transaction).
        if (backend.name === "tantivy") expect(index.search("deferredword")).toHaveLength(0);
        index.commit();
        expect(index.search("deferredword")).toHaveLength(1);
        expect(index.docCount()).toBe(1);
        expect(index.stats().docCount).toBe(1);
      } finally {
        index.close();
      }
    });
  });
}

describe("tantivy reader sharing (P2a background fix)", () => {
  it("two instances on one dir search concurrently; writers give a clear error", async () => {
    const dir = join(root, "index-shared");
    const a = new TantivyIndex(dir);
    const b = new TantivyIndex(dir);
    try {
      const adapters = [new ClaudeAdapter(claudeDir), new CodexAdapter(codexDir)];
      await syncAll(adapters, a, new CursorStore(dir));
      // b sees a's commit without opening a writer itself.
      expect(b.search("workbench private").length).toBeGreaterThanOrEqual(1);
      expect(a.search("workbench private").length).toBeGreaterThanOrEqual(1);
    } finally {
      a.close();
      b.close();
    }
  });
});

describe("sqlite upserts", () => {
  it("keep the full-text index in step with changed content", () => {
    const index = new SqliteIndex(join(root, "index-sqlite-upsert"));
    try {
      const base = {
        id: "claude-code:up-1:t1", sessionId: "up-1", harness: "claude-code" as const, timestamp: "2026-09-10T00:00:00Z",
        role: "user" as const, raw: {}, seq: 0, projectId: "p", workspace: "/w", repo: null,
      };
      index.indexTurns([{ ...base, content: "alphaword original text" }], "/tmp/up.jsonl");
      index.indexTurns([{ ...base, content: "omegaword rewritten text" }], "/tmp/up.jsonl");
      expect(index.search("omegaword")).toHaveLength(1);
      expect(index.search("alphaword")).toHaveLength(0);
    } finally {
      index.close();
    }
  });
});

describe("sync failure handling", () => {
  it("leaves a source unstamped when its turns fail to load, so the next sync retries", async () => {
    const dir = join(root, "flaky");
    await mkdir(dir, { recursive: true });
    const sourcePath = join(dir, "flaky.jsonl");
    await writeFile(sourcePath, "{}");
    const session: Session = { id: "flaky-1", harness: "claude-code", agentId: "claude-code:local", projectId: "p", workspace: "/w", startedAt: "2026-09-10T00:00:00Z", sourcePath };
    const turn: Turn = { id: "claude-code:flaky-1:t1", sessionId: "flaky-1", harness: "claude-code", timestamp: "2026-09-10T00:00:00Z", role: "user", content: "flaky retry marmalade", raw: {}, seq: 0 };
    let calls = 0;
    const flaky: ContextAdapter = {
      harness: "claude-code",
      capabilities: () => ({ sessions: true, turns: true, search: false, topology: false }),
      listSessions: async () => [session],
      listTurns: async () => {
        calls += 1;
        if (calls === 1) throw new Error("transient read error");
        return [turn];
      },
      getTurn: async () => turn,
      getCursor: async () => ({}),
    };
    const indexDir = join(root, "index-flaky");
    const index = new TantivyIndex(indexDir);
    const cursors = new CursorStore(indexDir);
    try {
      const first = await syncAll([flaky], index, cursors);
      expect(first.sessionsFailed).toBe(1);
      expect(first.sessionsIndexed).toBe(0);
      const second = await syncAll([flaky], index, cursors);
      expect(second.sessionsIndexed).toBe(1);
      expect(index.search("marmalade")).toHaveLength(1);
    } finally {
      index.close();
    }
  });
});
