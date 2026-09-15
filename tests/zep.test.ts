/**
 * Unit & Integration tests for Zep Context Lake Adapter (Phase E).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ZepAdapter } from "../src/adapters/zep.js";
import { createApp, closeApp, type GatewayApp } from "../src/app.js";
import { searchOnce } from "../src/commands.js";
import { syncAll } from "../src/indexing/sync.js";
import { CursorStore } from "../src/indexing/store.js";

let zepDir: string;
const ZEP_SESSION = "zep-thread-9999";

beforeAll(async () => {
  zepDir = await mkdtemp(join(tmpdir(), "acg-zep-"));
  const threadsData = [
    {
      uuid: ZEP_SESSION,
      user_id: "developer-alice",
      created_at: "2026-09-12T10:00:00Z",
      metadata: { project: "cozea-lake" },
      messages: [
        {
          uuid: "m1",
          role: "user",
          content: "What did we decide about the Zep context lake federation in src/lake/store.ts?",
          created_at: "2026-09-12T10:00:00Z",
        },
        {
          uuid: "m2",
          role: "assistant",
          content: "We agreed that Zep will act as an external read-only Context Source under spec §54, with PR #204.",
          created_at: "2026-09-12T10:01:00Z",
        },
      ],
    },
  ];

  await writeFile(join(zepDir, "threads.json"), JSON.stringify(threadsData, null, 2));
});

describe("ZepAdapter", () => {
  it("lists sessions from local thread exports with user agentId and project metadata", async () => {
    const adapter = new ZepAdapter({ localDir: zepDir });
    const sessions = await adapter.listSessions();
    expect(sessions.length).toBe(1);
    expect(sessions[0].id).toBe(ZEP_SESSION);
    expect(sessions[0].harness).toBe("zep");
    expect(sessions[0].agentId).toBe("zep:developer-alice");
    expect(sessions[0].projectId).toBe("cozea-lake");
  });

  it("normalizes messages into turns with fileRefs and stable IDs", async () => {
    const adapter = new ZepAdapter({ localDir: zepDir });
    const turns = await adapter.listTurns(ZEP_SESSION);
    expect(turns.length).toBe(2);
    expect(turns[0].role).toBe("user");
    expect(turns[1].role).toBe("assistant");
    expect(turns[0].fileRefs).toContain("src/lake/store.ts");
    expect(turns[1].fileRefs).toContain("PR #204");
    expect(turns[0].id).toContain("zep:zep-thread-9999:m1");
  });

  it("federates Zep turns into search alongside other harnesses", async () => {
    const root = await mkdtemp(join(tmpdir(), "acg-zep-search-"));
    const app = createApp({
      indexDir: join(root, "index"),
      claudeDir: join(root, "empty-c"),
      codexDir: join(root, "empty-x"),
      zepDir,
      backend: "tantivy",
      cursorDb: join(root, "no.vscdb"),
    });

    try {
      await syncAll(app.adapters, app.index, new CursorStore(join(root, "index")));
      const res = await searchOnce(app, "Zep context lake federation external source");
      expect(res.results.length).toBeGreaterThanOrEqual(1);
      const top = res.results[0];
      expect(top.provenance.harness).toBe("zep");
      expect(top.provenance.sessionId).toBe(ZEP_SESSION);
      expect(top.artifacts).toContain("src/lake/store.ts");
    } finally {
      closeApp(app);
    }
  });
});
