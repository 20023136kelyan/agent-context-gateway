/**
 * Session outcome records: status rules, what counts as the user's request,
 * what counts as a check, and the end-to-end path from native history (tool
 * results with exit statuses) to a search result that says how its session
 * ended.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import type { Turn } from "../src/core/models.js";
import type { Action } from "../src/actions/store.js";
import { ActionStore } from "../src/actions/store.js";
import { buildOutcome, userUtterance, isCheckCommand, summarizeOutcome } from "../src/outcomes/outcome.js";
import { createApp, closeApp, type GatewayApp } from "../src/app.js";
import { syncNow, searchOnce, sessionOutcome } from "../src/commands.js";

const S = { harness: "claude-code" as const, id: "s1", projectId: "app" };
let seq = 0;
const turn = (role: Turn["role"], content: string, ts: string): Turn => ({
  id: `t${seq}`, sessionId: "s1", harness: "claude-code", timestamp: ts, role, content, raw: null, seq: seq++,
});
const edit = (ts: string, target = "src/a.ts", ok?: boolean): Action => ({ kind: "edit", target, ts, turnId: "t0", ...(ok === undefined ? {} : { ok }) });
const cmd = (ts: string, target: string, ok?: boolean): Action => ({ kind: "command", target, ts, turnId: "t0", ...(ok === undefined ? {} : { ok }) });
const T = (m: number) => `2026-09-20T10:${String(m).padStart(2, "0")}:00Z`;

describe("what the user asked", () => {
  it("skips text the harnesses inject and replies that say nothing", () => {
    for (const injected of [
      "<environment_context>\n  <cwd>/repo</cwd>",
      "# AGENTS.md instructions for /repo",
      "<local-command-caveat>Caveat: ...",
      "<command-name>/model</command-name>",
      "[Request interrupted by user for tool use]",
      "This session is being continued from a previous conversation that ran out of context.",
      "Base directory for this skill: /x",
      "<task-notification> <task-id>1</task-id>",
      "continue",
      "ok thanks!",
      "yo",
    ]) {
      expect(userUtterance(turn("user", injected, T(0))), injected).toBeNull();
    }
    expect(userUtterance(turn("assistant", "fix the login bug please", T(0)))).toBeNull();
    expect(userUtterance(turn("user", "fix the login redirect loop", T(0)))).toBe("fix the login redirect loop");
  });

  it("reads the request out of a Codex IDE turn", () => {
    const ide = "# Files mentioned by the user:\n\n## app.ts: /repo/app.ts\n\n## My request for Codex:\nwhy does the build fail on node 22?";
    expect(userUtterance(turn("user", ide, T(0)))).toBe("why does the build fail on node 22?");
    expect(userUtterance(turn("user", "# Files mentioned by the user:\n\n## app.ts: /repo/app.ts", T(0)))).toBeNull();
  });
});

describe("what counts as a check", () => {
  it("tests, builds, type-checks and linters; not dev servers or reads", () => {
    for (const c of ["npm test", "npm run build", "pnpm typecheck", "npx tsc --noEmit", "npx vitest run tests/a.test.ts", "pytest -x tests", "python -m pytest", "cargo test", "go test ./...", "make check", "./gradlew test", "cd web && yarn lint", "swift build", "ruff check ."]) {
      expect(isCheckCommand(c), c).toBe(true);
    }
    for (const c of ["npm run dev", "npm install", "git status", "cat package.json", "ls tests", "node server.js", "rg pytest"]) {
      expect(isCheckCommand(c), c).toBe(false);
    }
  });
});

describe("status", () => {
  const turns = () => [turn("user", "fix the flaky websocket test", T(0)), turn("assistant", "Fixed: reconnect waits for the close event.", T(9))];

  it("verified: the last check after the last edit passed", () => {
    const o = buildOutcome(S, turns(), [edit(T(1)), cmd(T(2), "npm test", false), edit(T(3)), cmd(T(4), "npm test", true)]);
    expect(o.status).toBe("verified");
    expect(o.statusBecause).toContain("passed: npm test");
    expect(o.problem?.text).toBe("fix the flaky websocket test");
    expect(o.finalReply?.text).toContain("reconnect waits");
  });

  it("failing: an earlier pass does not count once a later edit follows it", () => {
    const o = buildOutcome(S, turns(), [edit(T(1)), cmd(T(2), "npm test", true), edit(T(3)), cmd(T(4), "npm test", false)]);
    expect(o.status).toBe("failing");
  });

  it("unverified: checks only before the last edit, or with no recorded result", () => {
    expect(buildOutcome(S, turns(), [edit(T(1)), cmd(T(2), "npm test", true), edit(T(3))]).status).toBe("unverified");
    const unknown = buildOutcome(S, turns(), [edit(T(1)), cmd(T(2), "npm test")]);
    expect(unknown.status).toBe("unverified");
    expect(unknown.statusBecause).toContain("does not record how they ended");
  });

  it("no-edits: rejected edits do not count as changes", () => {
    const o = buildOutcome(S, turns(), [edit(T(1), "src/a.ts", false), cmd(T(2), "npm test", true)]);
    expect(o.status).toBe("no-edits");
    expect(o.edits).toEqual({ count: 0, files: [], failed: 1 });
  });

  it("commit and revert after the last edit are reported", () => {
    expect(buildOutcome(S, turns(), [edit(T(1)), cmd(T(2), "git add -A && git commit -m fix", true)]).committed).toBe(true);
    expect(buildOutcome(S, turns(), [cmd(T(0), "git commit -m old", true), edit(T(1))]).committed).toBe(false);
    expect(buildOutcome(S, turns(), [edit(T(1)), cmd(T(2), "git checkout -- src/a.ts", true)]).reverted).toBe(true);
  });

  it("the user's last reaction after the last edit; a problem outweighs thanks", () => {
    const ts = [
      turn("user", "fix the flaky websocket test", T(0)),
      turn("user", "thanks, looks good", T(3)),
      turn("user", "thanks but it still fails on CI", T(5)),
    ];
    const o = buildOutcome(S, ts, [edit(T(2)), edit(T(4))]);
    expect(o.userReported?.tone).toBe("problem");
    expect(o.userReported?.cite.text).toContain("still fails");
    // A reaction to an earlier edit is not a reaction to the final state.
    expect(buildOutcome(S, ts.slice(0, 2), [edit(T(2)), edit(T(4))]).userReported).toBeNull();
  });

  it("asOf reads the session as it stood then", () => {
    const acts = [edit(T(1)), cmd(T(2), "npm test", true), edit(T(3)), cmd(T(4), "npm test", false)];
    expect(buildOutcome(S, turns(), acts, { asOf: T(2) }).status).toBe("verified");
    expect(buildOutcome(S, turns(), acts, { asOf: T(2) }).finalReply).toBeNull();
    expect(buildOutcome(S, turns(), acts).status).toBe("failing");
  });
});

describe("tasks: a long session is several requests, each judged on its own", () => {
  const session = () => [
    turn("user", "fix the flaky websocket test", T(0)), // seq a
    turn("assistant", "Fixed the reconnect wait.", T(4)),
    turn("user", "now add retry backoff to the uploader", T(10)), // seq b
    turn("assistant", "Added backoff.", T(12)),
  ];
  const acts = [edit(T(1)), cmd(T(2), "npm test", false), edit(T(3)), cmd(T(4), "npm test", true), edit(T(11), "src/upload.ts")];

  it("splits at each real request, with the work up to the next", () => {
    const o = buildOutcome(S, session(), acts);
    expect(o.tasks.map((t) => [t.request?.text, t.status])).toEqual([
      ["fix the flaky websocket test", "verified"],
      ["now add retry backoff to the uploader", "unverified"],
    ]);
    // The session-wide status still judges the session's final state.
    expect(o.status).toBe("unverified");
  });

  it("a search hit is summarized by the task it falls in", () => {
    const ts = session();
    const o = buildOutcome(S, ts, acts);
    expect(summarizeOutcome(o, ts[1]!.seq)).toMatchObject({ status: "verified", problem: "fix the flaky websocket test", task: "1/2" });
    expect(summarizeOutcome(o, ts[3]!.seq)).toMatchObject({ status: "unverified", problem: "now add retry backoff to the uploader", task: "2/2" });
    // Without a position: the last task that changed something.
    expect(summarizeOutcome(o).task).toBe("2/2");
  });

  it("the next short message is the verdict on a task; a long new request is not", () => {
    const longNew = "okay so I changed the path of the project and I think now it's not working when I use the command on the terminal because of that, can you look at the launcher script and the config it reads and figure out what moved?";
    expect(longNew.length).toBeGreaterThan(200);
    const o = buildOutcome(S, [turn("user", "fix the launcher", T(0)), turn("user", longNew, T(5))], [edit(T(1))]);
    expect(o.tasks[0]!.reaction).toBeNull();
    const short = buildOutcome(S, [turn("user", "fix the launcher", T(0)), turn("user", "still not working", T(5))], [edit(T(1))]);
    expect(short.tasks[0]!.reaction?.tone).toBe("problem");
    expect(short.userReported?.tone).toBe("problem");
  });

  it("'how that works' is a question, not praise", () => {
    const o = buildOutcome(S, [turn("user", "study the billing code", T(0)), turn("user", "also study how per-plan usage works", T(5))], [edit(T(1))]);
    expect(o.tasks[0]!.reaction).toBeNull();
    const praise = buildOutcome(S, [turn("user", "fix the launcher", T(0)), turn("user", "that works, thanks", T(5))], [edit(T(1))]);
    expect(praise.tasks[0]!.reaction?.tone).toBe("success");
  });

  it("a check that was already failing before a task's edits says so", () => {
    const ts = [turn("user", "restyle the tree rows", T(0)), turn("user", "now the folder lines too", T(10))];
    // The typecheck fails on an unrelated file throughout: before task 2's edit and after it.
    const acts = [edit(T(1)), cmd(T(2), "npm run typecheck", false), edit(T(11), "src/tree.css"), cmd(T(12), "npm run typecheck", false)];
    const o = buildOutcome(S, ts, acts);
    expect(o.tasks[1]).toMatchObject({ status: "failing", alreadyFailing: true });
    expect(o.tasks[1]!.statusBecause).toContain("already failing before");
    expect(summarizeOutcome(o, ts[1]!.seq)).toMatchObject({ status: "failing", alreadyFailing: true });
    // A check that passed before and fails after this task's edit is this task's failure.
    const fresh = buildOutcome(S, ts, [edit(T(1)), cmd(T(2), "npm run typecheck", true), edit(T(11)), cmd(T(12), "npm run typecheck", false)]);
    expect(fresh.tasks[1]).toMatchObject({ status: "failing", alreadyFailing: false });
    // A different check failing earlier says nothing about this one.
    const other = buildOutcome(S, ts, [cmd(T(2), "npm run lint", false), edit(T(11)), cmd(T(12), "npm run typecheck", false)]);
    expect(other.tasks[1]!.alreadyFailing).toBe(false);
  });

  it("no-edits mentions shell commands that may have written files", () => {
    const o = buildOutcome(S, [turn("user", "bump the version string", T(0))], [cmd(T(1), "sed -i '' 's/0.1/0.2/' package.json"), cmd(T(2), "echo done > /dev/null"), cmd(T(3), "npm test 2>&1")]);
    expect(o.status).toBe("no-edits");
    expect(o.shellWrites).toBe(1);
    expect(o.statusBecause).toContain("1 shell command may have written files");
  });

  it("work before any real request is a task without one", () => {
    const o = buildOutcome(S, [turn("assistant", "Reviewing the diff.", T(0))], [edit(T(1))]);
    expect(o.tasks).toHaveLength(1);
    expect(o.tasks[0]!.request).toBeNull();
    expect(o.tasks[0]!.status).toBe("unverified");
  });
});

describe("action store upgrade", () => {
  it("adds the result column to a store made before it, keeping rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "acg-outcome-store-"));
    const path = join(dir, "actions.sqlite");
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
    const old = new DatabaseSync(path);
    old.exec("CREATE TABLE actions (harness TEXT NOT NULL, session_id TEXT NOT NULL, ts TEXT NOT NULL, kind TEXT NOT NULL, target TEXT NOT NULL, rel TEXT NOT NULL, turn_id TEXT NOT NULL)");
    old.prepare("INSERT INTO actions VALUES (?, ?, ?, ?, ?, ?, ?)").run("codex", "c1", T(0), "command", "npm test", "npm test", "t");
    old.close();
    const store = new ActionStore(path);
    expect(store.find({ command: "npm test" })).toEqual([expect.objectContaining({ sessionId: "c1" })]);
    expect(store.find({ command: "npm test" })[0]).not.toHaveProperty("ok");
    store.replaceSession("codex", "c2", "/r", [cmd(T(1), "npm test", false)]);
    expect(store.find({ command: "npm test" })[0]).toMatchObject({ sessionId: "c2", ok: false });
    store.close();
  });
});

describe("end to end: native history -> outcome -> search result", () => {
  let root: string;
  let app: GatewayApp;
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "acg-outcome-e2e-"));
    const claude = join(root, "claude", "-Users-alice-app");
    mkdirSync(claude, { recursive: true });
    const L = (o: object) => JSON.stringify({ sessionId: "s1", cwd: "/Users/alice/app", ...o });
    writeFileSync(
      join(claude, "s1.jsonl"),
      [
        L({ type: "user", uuid: "u1", timestamp: T(0), message: { role: "user", content: "The websocket reconnect loop spins forever after a 401; fix it" } }),
        L({ type: "assistant", uuid: "a1", timestamp: T(1), message: { role: "assistant", content: [
          { type: "tool_use", id: "e1", name: "Edit", input: { file_path: "/Users/alice/app/src/ws.ts", old_string: "a", new_string: "b" } },
        ] } }),
        L({ type: "user", uuid: "r1", timestamp: T(1), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "e1", content: "ok" }] } }),
        L({ type: "assistant", uuid: "a2", timestamp: T(2), message: { role: "assistant", content: [{ type: "tool_use", id: "b1", name: "Bash", input: { command: "npm test" } }] } }),
        L({ type: "user", uuid: "r2", timestamp: T(2), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "b1", is_error: true, content: "Exit code 1\n1 failed" }] } }),
        L({ type: "assistant", uuid: "a3", timestamp: T(3), message: { role: "assistant", content: [
          { type: "tool_use", id: "e2", name: "Edit", input: { file_path: "/Users/alice/app/src/ws.ts", old_string: "b", new_string: "c" } },
        ] } }),
        L({ type: "user", uuid: "r3", timestamp: T(3), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "e2", content: "ok" }] } }),
        L({ type: "assistant", uuid: "a4", timestamp: T(4), message: { role: "assistant", content: [{ type: "tool_use", id: "b2", name: "Bash", input: { command: "npm test" } }] } }),
        L({ type: "user", uuid: "r4", timestamp: T(4), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "b2", is_error: false, content: "all passed" }] } }),
        L({ type: "assistant", uuid: "a5", timestamp: T(5), message: { role: "assistant", content: "Fixed: a 401 now stops the reconnect loop and refreshes the token." } }),
      ].join("\n"),
    );
    const day = join(root, "codex", "2026", "09", "20");
    mkdirSync(day, { recursive: true });
    writeFileSync(
      join(day, "rollout-c1.jsonl"),
      [
        { timestamp: T(0), type: "session_meta", payload: { id: "c1", cwd: "/Users/alice/app" } },
        { timestamp: T(0), type: "response_item", payload: { type: "message", id: "m1", role: "user", content: [{ type: "input_text", text: "Add retries to the websocket client" }] } },
        { timestamp: T(1), type: "response_item", payload: { type: "custom_tool_call", id: "p1", name: "apply_patch", input: "*** Begin Patch\n*** Update File: src/ws.ts\n@@\n-a\n+b\n*** End Patch", call_id: "k1" } },
        { timestamp: T(1), type: "response_item", payload: { type: "custom_tool_call_output", call_id: "k1", output: "Success. Updated the following files:\nM src/ws.ts" } },
        { timestamp: T(2), type: "response_item", payload: { type: "function_call", id: "f1", name: "exec_command", arguments: JSON.stringify({ cmd: "npm test" }), call_id: "k2" } },
        { timestamp: T(2), type: "response_item", payload: { type: "function_call_output", call_id: "k2", output: "Chunk ID: 1 | Wall time: 2.0 seconds\nProcess exited with code 1\nOutput:\n2 failed" } },
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

  it("Claude: is_error on tool results decides the status", async () => {
    const o = await sessionOutcome(app, "claude-code", "s1");
    expect(o.status).toBe("verified");
    expect(o.checks.map((c) => c.ok)).toEqual([false, true]);
    expect(o.edits.files).toEqual(["/Users/alice/app/src/ws.ts"]);
    expect(o.problem?.text).toContain("reconnect loop spins forever");
    expect(o.finalReply?.text).toContain("stops the reconnect loop");
    // Point in time: before the fix, the last check had failed.
    expect((await sessionOutcome(app, "claude-code", "s1", { asOf: T(2) })).status).toBe("failing");
  });

  it("Codex: exit codes and patch verdicts in tool output decide the status", async () => {
    const o = await sessionOutcome(app, "codex", "c1");
    expect(o.status).toBe("failing");
    expect(o.edits.count).toBe(1);
    expect(o.lastCheck).toMatchObject({ command: "npm test", ok: false });
  });

  it("search results say how their session ended", async () => {
    const res = await searchOnce(app, "websocket reconnect 401", { project: "*", semantic: false, rerank: false });
    const byId = Object.fromEntries(res.results.map((r) => [r.provenance.sessionId, r.outcome]));
    expect(byId.s1).toMatchObject({ status: "verified", problem: expect.stringContaining("reconnect loop") });
    const off = await searchOnce(app, "websocket reconnect 401", { project: "*", semantic: false, rerank: false, outcomes: false });
    expect(off.results.every((r) => r.outcome === undefined)).toBe(true);
  });

  it("unknown sessions are not_found", async () => {
    await expect(sessionOutcome(app, "claude-code", "nope")).rejects.toThrow(/not_found/);
  });
});
