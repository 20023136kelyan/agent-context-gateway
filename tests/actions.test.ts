/**
 * Action index (src/actions/store.ts): which sessions edited a file or ran a
 * command, as exact facts from tool calls, kept out of the search ranking.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { actionsOfCall, ActionStore } from "../src/actions/store.js";
import { createApp, closeApp, type GatewayApp } from "../src/app.js";
import { syncNow, findActions, getContext } from "../src/commands.js";

describe("actionsOfCall", () => {
  const at = ["2026-09-01T10:00:00Z", "t1"] as const;
  it("reads Claude edits and commands from tool_use input", () => {
    expect(actionsOfCall("Edit", { file_path: "/r/src/a.ts", old_string: "x" }, ...at)).toEqual([{ kind: "edit", target: "/r/src/a.ts", ts: at[0], turnId: "t1" }]);
    expect(actionsOfCall("NotebookEdit", { notebook_path: "nb.ipynb" }, ...at)[0].target).toBe("nb.ipynb");
    expect(actionsOfCall("Bash", { command: "git pull origin main", description: "Pull" }, ...at)).toEqual([{ kind: "command", target: "git pull origin main", ts: at[0], turnId: "t1" }]);
  });
  it("reads every file a Codex patch touches, and joined shell commands", () => {
    const patch = "*** Begin Patch\n*** Update File: src/a.ts\n*** Add File: src/b.ts\n*** Delete File: old.ts\n*** End Patch";
    expect(actionsOfCall("apply_patch", patch, ...at).map((a) => a.target)).toEqual(["src/a.ts", "src/b.ts", "old.ts"]);
    expect(actionsOfCall("shell", "bash -lc npm run db:migrate", ...at)[0]).toMatchObject({ kind: "command", target: "bash -lc npm run db:migrate" });
  });
  it("ignores tools that neither edit nor run anything", () => {
    expect(actionsOfCall("Read", { file_path: "src/a.ts" }, ...at)).toEqual([]);
    expect(actionsOfCall("Grep", { pattern: "x" }, ...at)).toEqual([]);
  });
});

describe("ActionStore", () => {
  let store: ActionStore;
  beforeAll(() => {
    store = new ActionStore(join(mkdtempSync(join(tmpdir(), "acg-actions-store-")), "a", "actions.sqlite"));
    store.replaceSession("claude-code", "s1", "/repo", [
      { kind: "edit", target: "/repo/src/api/client.ts", ts: "2026-09-01T10:00:00.500Z", turnId: "t1" },
      { kind: "edit", target: "/repo/src/api/apiclient.ts", ts: "2026-09-01T10:00:01Z", turnId: "t1" },
      { kind: "command", target: "git pull origin main", ts: "2026-09-01T10:00:02Z", turnId: "t2" },
    ]);
    store.replaceSession("codex", "c1", "/other/checkout", [{ kind: "edit", target: "src/api/client.ts", ts: "2026-09-02T09:00:00Z", turnId: "c-t1" }]);
  });
  afterAll(() => store.close());

  it("matches a file by path tail on a / boundary, relative or absolute", () => {
    const hits = store.find({ file: "client.ts" });
    expect(hits.map((h) => h.sessionId)).toEqual(["c1", "s1"]); // newest first
    expect(hits.find((h) => h.sessionId === "s1")!.rel).toBe("src/api/client.ts");
    expect(store.find({ file: "src/api/client.ts" })).toHaveLength(2);
    expect(store.find({ file: "/repo/src/api/client.ts" })).toHaveLength(1);
  });
  it("matches commands by substring, and treats LIKE wildcards literally", () => {
    expect(store.find({ command: "git pull" })).toHaveLength(1);
    expect(store.find({ command: "%" })).toHaveLength(0);
  });
  it("filters by session and by time, across timestamp precisions", () => {
    expect(store.find({ file: "client.ts", sessionIds: ["s1"] })).toHaveLength(1);
    expect(store.find({ file: "client.ts", sessionIds: [] })).toHaveLength(0);
    expect(store.find({ file: "client.ts", since: "2026-09-01T10:00:00Z" })).toHaveLength(2);
    expect(store.find({ file: "client.ts", since: "2026-09-02T00:00:00Z" }).map((h) => h.sessionId)).toEqual(["c1"]);
  });
  it("replaces a session's rows rather than appending", () => {
    store.replaceSession("claude-code", "s1", "/repo", []);
    expect(store.find({ file: "client.ts" }).map((h) => h.sessionId)).toEqual(["c1"]);
  });
});

describe("findActions, end to end through sync", () => {
  let root: string;
  let app: GatewayApp;
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "acg-actions-e2e-"));
    const claude = join(root, "claude", "-Users-alice-app");
    mkdirSync(claude, { recursive: true });
    writeFileSync(
      join(claude, "s1.jsonl"),
      [
        { type: "user", uuid: "u1", sessionId: "s1", cwd: "/Users/alice/app", timestamp: "2026-09-01T10:00:00Z", message: { role: "user", content: "Sync main and fix the api client" } },
        { type: "assistant", uuid: "a1", sessionId: "s1", cwd: "/Users/alice/app", timestamp: "2026-09-01T10:01:00Z", message: { role: "assistant", content: [
          { type: "tool_use", id: "x1", name: "Bash", input: { command: "git pull origin main" } },
          { type: "tool_use", id: "x2", name: "Edit", input: { file_path: "/Users/alice/app/src/api/client.ts", old_string: "a", new_string: "b" } },
        ] } },
      ].map((l) => JSON.stringify(l)).join("\n"),
    );
    const other = join(root, "claude", "-Users-alice-other");
    mkdirSync(other, { recursive: true });
    writeFileSync(
      join(other, "s2.jsonl"),
      [
        { type: "user", uuid: "u2", sessionId: "s2", cwd: "/Users/alice/other", timestamp: "2026-09-03T10:00:00Z", message: { role: "user", content: "Tweak the other client" } },
        { type: "assistant", uuid: "a2", sessionId: "s2", cwd: "/Users/alice/other", timestamp: "2026-09-03T10:01:00Z", message: { role: "assistant", content: [{ type: "tool_use", id: "y1", name: "Write", input: { file_path: "/Users/alice/other/src/api/client.ts", content: "x" } }] } },
      ].map((l) => JSON.stringify(l)).join("\n"),
    );
    const day = join(root, "codex", "2026", "09", "02");
    mkdirSync(day, { recursive: true });
    writeFileSync(
      join(day, "rollout-c1.jsonl"),
      [
        { timestamp: "2026-09-02T09:00:00Z", type: "session_meta", payload: { id: "c1", cwd: "/home/bob/app" } },
        { timestamp: "2026-09-02T09:00:01Z", type: "response_item", payload: { type: "message", id: "m1", role: "user", content: [{ type: "input_text", text: "Add retries to the client" }] } },
        { timestamp: "2026-09-02T09:01:00Z", type: "response_item", payload: { type: "custom_tool_call", id: "p1", name: "apply_patch", input: "*** Begin Patch\n*** Update File: src/api/client.ts\n@@\n-a\n+b\n*** End Patch", call_id: "k1" } },
        { timestamp: "2026-09-02T09:02:00Z", type: "response_item", payload: { type: "function_call", id: "f1", name: "shell", arguments: JSON.stringify({ command: ["npm", "run", "db:migrate"] }), call_id: "k2" } },
      ].map((l) => JSON.stringify(l)).join("\n"),
    );
    const dead = (n: string) => {
      const d = join(root, n);
      mkdirSync(d, { recursive: true });
      return d;
    };
    app = createApp({
      stateDir: join(root, "state"), claudeDir: join(root, "claude"), codexDir: join(root, "codex"), indexDir: join(root, "index"),
      cursorDb: dead("cursor"), zepDir: dead("zep"), opencodeDb: dead("opencode"), trajectoryDir: dead("traj"), gitRepos: [],
    });
    await syncNow(app);
  });
  afterAll(() => {
    closeApp(app);
    rmSync(root, { recursive: true, force: true });
  });

  it("finds every session that edited a file, across harnesses, newest first", async () => {
    const res = await findActions(app, { file: "client.ts", project: "*" });
    expect(res.sessions.map((s) => s.sessionId)).toEqual(["s2", "c1", "s1"]);
  });

  it("scopes to the caller's project like search, matched across harnesses", async () => {
    const res = await findActions(app, { file: "client.ts", defaultProject: "app" });
    expect(res.projectScope).toEqual({ project: "app", source: "caller" });
    expect(res.sessions.map((s) => s.sessionId).sort()).toEqual(["c1", "s1"]);
  });

  it("finds commands, including Codex shell calls that are not searchable turns", async () => {
    expect((await findActions(app, { command: "git pull", project: "*" })).sessions.map((s) => s.sessionId)).toEqual(["s1"]);
    expect((await findActions(app, { command: "db:migrate", project: "*" })).sessions.map((s) => s.sessionId)).toEqual(["c1"]);
  });

  it("points every action at a turn that opens with context", async () => {
    const res = await findActions(app, { file: "client.ts", project: "*" });
    for (const s of res.sessions) {
      for (const a of s.actions) {
        const ctx = await getContext(app, s.harness, s.sessionId, a.turnId, 1);
        expect(JSON.stringify(ctx)).toContain(a.turnId);
      }
    }
  });

  it("refuses a query with nothing to match", async () => {
    await expect(findActions(app, {})).rejects.toThrow(/bad_request/);
  });
});

describe("actionsOfCall: Codex Desktop code mode (real shapes)", () => {
  // `exec`/`js` inputs are scripts. In one real corpus 3.6k exec calls ran
  // commands through tools.exec_command and wrote patches as string literals
  // with escaped newlines, which the plain patch regex read as one long line.
  const at = ["2026-09-01T10:00:00Z", "t1"] as const;
  it("finds commands run through tools.exec_command, JSON-decoded", () => {
    const script = 'const r = await tools.exec_command({"cmd":"git pull origin \\"main\\"","yield_time_ms":1000});';
    expect(actionsOfCall("exec", script, ...at)).toEqual([{ kind: "command", target: 'git pull origin "main"', ts: at[0], turnId: "t1" }]);
  });
  it("reads every header of a patch quoted as a script string literal", () => {
    const script = 'const patch = "*** Begin Patch\\n*** Update File: /Users/eve/app/src/App.tsx\\n@@\\n-a\\n+b\\n*** Add File: src/risk.py\\n+x\\n*** End Patch";\nawait tools.apply_patch(patch);';
    expect(actionsOfCall("exec", script, ...at).map((a) => a.target)).toEqual(["/Users/eve/app/src/App.tsx", "src/risk.py"]);
  });
  it("reads a native exec_command call's command line", () => {
    expect(actionsOfCall("exec_command", "npm run dev", ...at)).toEqual([{ kind: "command", target: "npm run dev", ts: at[0], turnId: "t1" }]);
  });
  it("ignores code-mode scripts that neither run a command nor patch", () => {
    expect(actionsOfCall("js", '{"code":"await chrome.click(0)"}', ...at)).toEqual([]);
  });
});
