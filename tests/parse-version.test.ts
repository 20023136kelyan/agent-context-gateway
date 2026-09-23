/**
 * PARSE_VERSION: a parser change must reach an existing index. Sync skips
 * files whose mtime/size did not move, and re-indexing upserts by id, so
 * without a version check an upgraded install would keep the old parse
 * forever, including docs whose ids no longer exist.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, closeApp } from "../src/app.js";
import { syncNow, searchOnce } from "../src/commands.js";
import { PARSE_VERSION } from "../src/adapters/types.js";
import type { Turn } from "../src/core/models.js";

describe("parser version", () => {
  it("rebuilds an index built by an older parser, once", async () => {
    const root = mkdtempSync(join(tmpdir(), "acg-parse-"));
    const claude = join(root, "claude", "proj");
    mkdirSync(claude, { recursive: true });
    writeFileSync(
      join(claude, "s1.jsonl"),
      JSON.stringify({ type: "user", uuid: "u1", sessionId: "s1", cwd: "/repo", timestamp: "2026-09-01T10:00:00Z", message: { role: "user", content: "Fix the flaky login test" } }),
    );
    const dead = (n: string) => {
      const d = join(root, n);
      mkdirSync(d, { recursive: true });
      return d;
    };
    const saved = process.env.CONTEXT_GATEWAY_STATE;
    process.env.CONTEXT_GATEWAY_STATE = join(root, "state");
    const app = createApp({
      claudeDir: join(root, "claude"), codexDir: dead("codex"), indexDir: join(root, "index"),
      cursorDb: dead("cursor"), zepDir: dead("zep"), opencodeDb: dead("opencode"), trajectoryDir: dead("traj"), gitRepos: [],
    });
    try {
      const first = await syncNow(app);
      expect(first.reparsed).toBe(false);
      const docs = app.index.docCount();
      expect(readFileSync(join(root, "index", "parse-version"), "utf8")).toBe(String(PARSE_VERSION));

      // An older parser's leftovers: a doc under an id the current parse never
      // produces, and a recorded version from before the change.
      const ghost = { id: "claude-code:s1:gone", sessionId: "s1", harness: "claude-code", timestamp: "2026-09-01T10:00:00Z", role: "user", content: "ghost turn", raw: {}, seq: 9 } as Turn;
      app.index.indexTurns([ghost], join(claude, "s1.jsonl"));
      writeFileSync(join(root, "index", "parse-version"), "1");
      expect(app.index.docCount()).toBe(docs + 1);

      const upgraded = await syncNow(app);
      expect(upgraded.reparsed).toBe(true);
      expect(app.index.docCount()).toBe(docs);
      expect(readFileSync(join(root, "index", "parse-version"), "utf8")).toBe(String(PARSE_VERSION));

      expect((await syncNow(app)).reparsed).toBe(false);

      // The first query after an upgrade rebuilds too, without a `sync`.
      writeFileSync(join(root, "index", "parse-version"), "1");
      app.index.indexTurns([ghost], join(claude, "s1.jsonl"));
      await searchOnce(app, "flaky login", { semantic: false });
      expect(app.index.docCount()).toBe(docs);
      expect(readFileSync(join(root, "index", "parse-version"), "utf8")).toBe(String(PARSE_VERSION));
    } finally {
      closeApp(app);
      if (saved === undefined) delete process.env.CONTEXT_GATEWAY_STATE;
      else process.env.CONTEXT_GATEWAY_STATE = saved;
    }
  });
});
