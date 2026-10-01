import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ItemStore } from "../src/store/store.js";
import { startDaemon, type StartedDaemon } from "../src/daemon/server.js";
import { callDaemon } from "../src/daemon/client.js";
import { toOutput, toRequest } from "../src/clients/hook.js";
import { install } from "../src/clients/install.js";
import { SESSION_EXPLANATION } from "../src/delivery/format.js";
import { parseAnchor } from "../src/store/items.js";

describe("daemon", () => {
  let store: ItemStore;
  let daemon: StartedDaemon;
  let repo: string;

  beforeAll(async () => {
    repo = mkdtempSync(join(tmpdir(), "bifrost-repo-"));
    store = new ItemStore(":memory:");
    store.add({ repo, type: "preference", text: "Use ';' in finance CSVs.", anchor: parseAnchor("src/exports/"), source: { kind: "hand" } });
    store.add({ repo, type: "decision", text: "The product is a service.", anchor: parseAnchor("."), source: { kind: "hand" } });
    daemon = await startDaemon({ store, port: 0, infoPath: null });
  });
  afterAll(async () => {
    await daemon.close();
    store.close();
    rmSync(repo, { recursive: true, force: true });
  });

  it("answers tool calls and session starts", async () => {
    const tool = await callDaemon("/tool", { cwd: repo, session: "s1", client: "test", tool: "Write", input: { file_path: join(repo, "src/exports/new.js") } }, { port: daemon.port });
    expect(tool?.text).toContain("BIFRÖST src/exports/");
    const start = await callDaemon("/session", { cwd: repo, session: "s2", client: "test" }, { port: daemon.port });
    expect(start?.text.startsWith(SESSION_EXPLANATION)).toBe(true);
    expect(start?.text).toContain("The product is a service.");
    const projectOnly = await callDaemon("/session", { cwd: repo, session: "s3", client: "opencode", explain: false }, { port: daemon.port });
    expect(projectOnly?.text.startsWith("BIFRÖST (project)")).toBe(true);
  });

  it("refuses requests without its header, and fails open on bad input", async () => {
    const res = await fetch(`http://127.0.0.1:${daemon.port}/health`);
    expect(res.status).toBe(403);
    const ok = await fetch(`http://127.0.0.1:${daemon.port}/health`, { headers: { "x-bifrost": "1" } });
    expect(await ok.json()).toMatchObject({ ok: true });
    expect(await callDaemon("/tool", { cwd: repo, session: "s", client: "t", tool: "Read", input: "nonsense" }, { port: daemon.port })).toEqual({ text: "", shown: [] });
  });

  it("returns null when no daemon answers", async () => {
    expect(await callDaemon("/tool", {}, { port: 1, timeoutMs: 200 })).toBeNull();
  });
});

describe("client hook formats", () => {
  it("translates each client's payload", () => {
    expect(toRequest("claude-code", "pre-tool", { session_id: "s", cwd: "/r", tool_name: "Read", tool_input: { file_path: "/r/a.js" } })).toEqual({
      path: "/tool",
      body: { cwd: "/r", session: "s", client: "claude-code", tool: "Read", input: { file_path: "/r/a.js" } },
    });
    expect(toRequest("codex", "post-tool", { session_id: "c", cwd: "/r", tool_name: "apply_patch", tool_input: { command: "*** Update File: a.js" } })?.body).toMatchObject({ tool: "apply_patch", input: { patch: "*** Update File: a.js" } });
    expect(toRequest("cursor", "post-tool", { conversation_id: "k", workspace_roots: ["/r"], tool_name: "Shell", tool_input: { command: "ls" } })?.body).toMatchObject({ cwd: "/r", session: "k", tool: "Bash" });
    expect(toRequest("cursor", "session-start", { session_id: "k2", workspace_roots: ["/r"] })).toEqual({ path: "/session", body: { cwd: "/r", session: "k2", client: "cursor" } });
    expect(toRequest("claude-code", "pre-tool", { session_id: "s", cwd: "/r" })).toBeNull();
    expect(toRequest("claude-code", "stop", {})).toBeNull();
  });

  it("answers in each client's format, and with nothing when there is nothing", () => {
    expect(JSON.parse(toOutput("claude-code", "pre-tool", "x"))).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: "x" } });
    expect(JSON.parse(toOutput("codex", "post-tool", "x"))).toEqual({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "x" } });
    expect(JSON.parse(toOutput("codex", "session-start", "x"))).toEqual({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "x" } });
    expect(JSON.parse(toOutput("cursor", "post-tool", "x"))).toEqual({ additional_context: "x" });
    expect(toOutput("claude-code", "pre-tool", "")).toBe("");
  });
});

describe("install", () => {
  const cliPath = "/opt/bifrost/dist/cli.js";
  const setup = () => {
    const home = mkdtempSync(join(tmpdir(), "bifrost-home-"));
    return { home, o: { cliPath, scope: "user" as const, cwd: home, home, nodePath: "/usr/bin/node" } };
  };

  it("adds Claude Code hooks next to existing ones, once", () => {
    const { home, o } = setup();
    const file = join(home, ".claude", "settings.json");
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(file, JSON.stringify({ model: "x", hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "my-guard" }] }] } }));
    install("claude-code", o);
    install("claude-code", o);
    const c = JSON.parse(readFileSync(file, "utf8"));
    expect(c.model).toBe("x");
    expect(c.hooks.PreToolUse).toHaveLength(2);
    expect(c.hooks.PreToolUse[1].hooks[0].command).toBe('"/usr/bin/node" "/opt/bifrost/dist/hook-main.js" claude-code pre-tool');
    expect(c.hooks.SessionStart).toHaveLength(1);
    rmSync(home, { recursive: true, force: true });
  });

  it("writes Codex and Cursor hook files", () => {
    const { home, o } = setup();
    install("codex", o);
    install("cursor", o);
    install("cursor", o);
    const codex = JSON.parse(readFileSync(join(home, ".codex", "hooks.json"), "utf8"));
    expect(codex.hooks.PostToolUse[0].hooks[0].command).toContain("codex post-tool");
    const cursor = JSON.parse(readFileSync(join(home, ".cursor", "hooks.json"), "utf8"));
    expect(cursor.version).toBe(1);
    expect(cursor.hooks.postToolUse).toEqual([{ command: '"/usr/bin/node" "/opt/bifrost/dist/hook-main.js" cursor post-tool' }]);
    expect(cursor.hooks.sessionStart).toHaveLength(1);
    rmSync(home, { recursive: true, force: true });
  });

  it("registers the OpenCode plugin and the fixed explanation", () => {
    const { home, o } = setup();
    const prev = process.env.BIFROST_DB;
    process.env.BIFROST_DB = join(home, "data", "bifrost.db");
    try {
      install("opencode", o);
      install("opencode", o);
      const c = JSON.parse(readFileSync(join(home, ".config", "opencode", "opencode.json"), "utf8"));
      expect(c.plugin).toEqual(["file:///opt/bifrost/dist/clients/opencode-plugin.js"]);
      expect(c.instructions).toEqual([join(home, "data", "session.md")]);
      expect(readFileSync(join(home, "data", "session.md"), "utf8").trim()).toBe(SESSION_EXPLANATION);
    } finally {
      if (prev === undefined) delete process.env.BIFROST_DB;
      else process.env.BIFROST_DB = prev;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("refuses to rewrite a config it cannot parse, and needs the built CLI", () => {
    const { home, o } = setup();
    mkdirSync(join(home, ".cursor"), { recursive: true });
    writeFileSync(join(home, ".cursor", "hooks.json"), "{ // comment\n}");
    expect(() => install("cursor", o)).toThrow(/not plain JSON/);
    expect(readFileSync(join(home, ".cursor", "hooks.json"), "utf8")).toBe("{ // comment\n}");
    expect(() => install("codex", { ...o, cliPath: "/src/cli.ts" })).toThrow(/npm run build/);
    expect(() => install("vim", o)).toThrow(/unknown client/);
    expect(existsSync(join(home, ".codex"))).toBe(false);
    rmSync(home, { recursive: true, force: true });
  });
});
