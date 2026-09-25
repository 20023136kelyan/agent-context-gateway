/**
 * GATEWAY_AS_OF (commands.ts pinAsOf): the whole gateway sees history as it
 * stood at one moment, so a replayed task cannot learn how it turned out.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createApp, closeApp, type GatewayApp } from "../src/app.js";
import { buildMcpServer } from "../src/transports/mcp.js";
import {
  syncNow, searchOnce, listSessions, sessionOutcome, getTurn, getContext, findActions, getRelated, pinAsOf,
} from "../src/commands.js";

const PIN = "2026-09-02T00:00:00.000Z";

describe("GATEWAY_AS_OF pins every read", () => {
  let root: string;
  let app: GatewayApp;
  const line = (o: object) => JSON.stringify(o);
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "acg-pin-"));
    const claude = join(root, "claude", "-Users-alice-app");
    mkdirSync(claude, { recursive: true });
    const cwd = "/Users/alice/app";
    // s1 starts before the pin and goes on after it; s2 starts after it.
    writeFileSync(
      join(claude, "s1.jsonl"),
      [
        { type: "user", uuid: "u1", sessionId: "s1", cwd, timestamp: "2026-09-01T10:00:00Z", message: { role: "user", content: "the zebracorn importer drops rows" } },
        { type: "assistant", uuid: "a1", sessionId: "s1", cwd, timestamp: "2026-09-01T10:01:00Z", message: { role: "assistant", content: [
          { type: "tool_use", id: "x1", name: "Edit", input: { file_path: `${cwd}/src/importer.ts`, old_string: "a", new_string: "b" } },
        ] } },
        { type: "user", uuid: "u2", sessionId: "s1", cwd, timestamp: "2026-09-03T10:00:00Z", message: { role: "user", content: "zebracorn fixed for good: the answer was the CSV quoting" } },
        { type: "assistant", uuid: "a2", sessionId: "s1", cwd, timestamp: "2026-09-03T10:01:00Z", message: { role: "assistant", content: [
          { type: "tool_use", id: "x2", name: "Edit", input: { file_path: `${cwd}/src/csv.ts`, old_string: "a", new_string: "b" } },
        ] } },
      ].map(line).join("\n"),
    );
    writeFileSync(
      join(claude, "s2.jsonl"),
      [
        { type: "user", uuid: "v1", sessionId: "s2", cwd, timestamp: "2026-09-04T10:00:00Z", message: { role: "user", content: "zebracorn follow-up after the pin" } },
      ].map(line).join("\n"),
    );
    const dead = (n: string) => {
      const d = join(root, n);
      mkdirSync(d, { recursive: true });
      return d;
    };
    process.env.GATEWAY_AS_OF = PIN;
    app = createApp({
      stateDir: join(root, "state"), claudeDir: join(root, "claude"), codexDir: dead("codex"), indexDir: join(root, "index"),
      cursorDb: dead("cursor"), zepDir: dead("zep"), opencodeDb: dead("opencode"), trajectoryDir: dead("traj"), gitRepos: [],
    });
    delete process.env.GATEWAY_AS_OF;
    await syncNow(app);
  });
  afterAll(() => {
    closeApp(app);
    rmSync(root, { recursive: true, force: true });
  });

  it("clamps a requested moment to the pin, and keeps an earlier one", () => {
    expect(app.settings.asOfPin).toBe(PIN);
    expect(pinAsOf(app, undefined)).toBe(PIN);
    expect(pinAsOf(app, "2026-12-01T00:00:00Z")).toBe(PIN);
    expect(pinAsOf(app, "2026-08-01T00:00:00Z")).toBe("2026-08-01T00:00:00Z");
  });

  it("search, sessions and outcomes see only what existed at the pin", async () => {
    const res = await searchOnce(app, "zebracorn", { project: "*", semantic: false, rerank: false, maxResults: 10 });
    expect(res.results.map((r) => r.provenance.turnId)).toEqual([expect.stringContaining(":u1")]);
    expect((await listSessions(app)).map((s) => s.id)).toEqual(["s1"]);
    await expect(sessionOutcome(app, "claude-code", "s2")).rejects.toThrow("not_found");
    const o = await sessionOutcome(app, "claude-code", "s1");
    expect(o.edits.files).toEqual(["/Users/alice/app/src/importer.ts"]);
  });

  it("a pinned MCP server does not offer the reads it cannot pin", async () => {
    const server = buildMcpServer(app, "/Users/alice/app");
    const client = new Client({ name: "pin-test", version: "0.0.0" });
    const [c, t] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(t), client.connect(c)]);
    try {
      const names = (await client.listTools()).tools.map((x) => x.name);
      expect(names).toContain("context.search");
      expect(names).toContain("context.get_context");
      for (const gone of ["context.get_related", "context.traverse_artifacts", "context.search_live", "context.explore_lineage"]) expect(names).not.toContain(gone);
      const res = await client.callTool({ name: "context.search", arguments: { query: "zebracorn", project: "*" } });
      expect((res.content as { text: string }[])[0]!.text).not.toContain("CSV quoting");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("turns, windows and actions after the pin stay hidden; unpinnable reads refuse", async () => {
    await expect(getTurn(app, "claude-code", "s1", "claude-code:s1:u2")).rejects.toThrow("not_found");
    const window = await getContext(app, "claude-code", "s1", "claude-code:s1:u1", 5);
    expect(window.map((t) => t.id)).not.toContain("claude-code:s1:u2");
    const acts = await findActions(app, { file: "csv.ts", project: "*" });
    expect(acts.sessions).toEqual([]);
    expect((await findActions(app, { file: "importer.ts", project: "*" })).sessions.map((s) => s.sessionId)).toEqual(["s1"]);
    await expect(getRelated(app, "src/importer.ts")).rejects.toThrow("not_supported");
  });
});
