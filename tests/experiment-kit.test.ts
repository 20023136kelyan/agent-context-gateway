import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
// @ts-expect-error plain ESM module without type declarations
import { formatNotes, matchNotes, placesFromToolCall, sanitize, loadNotes, fromOpenCodeCall } from "../experiments/upper-bound/kit/notes-lib.mjs";
// @ts-expect-error plain ESM module without type declarations
import { BifrostPlugin } from "../experiments/upper-bound/kit/opencode-plugin.mjs";
import { parseTrace, renderDigest, renderFull, scrub } from "../experiments/upper-bound/harness/trace.js";
import { generateNotes, validateNotes, listRepoFiles } from "../experiments/upper-bound/harness/generate.js";
import { buildAgentCommand, grade, invalidReason, loadTask, prepareWorkspace, metricsFromTrace, resolveArm, runOne, outcomeText, type RunOptions } from "../experiments/upper-bound/harness/run.js";
import { buildReport, bootstrapDiff } from "../experiments/upper-bound/harness/report.js";

const EXP = resolve(__dirname, "../experiments/upper-bound");
const TASK = join(EXP, "tasks/refresh-rotation");
const HAND = join(TASK, "notes/hand.json");
const HOOK = join(EXP, "kit/hook.mjs");

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "exp-kit-test-"));
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("notes-lib", () => {
  const root = "/repo";
  it("maps OpenCode tool calls to the kit's names", () => {
    expect(fromOpenCodeCall("read", { filePath: "/repo/src/a.js" })).toMatchObject({ tool: "Read", input: { file_path: "/repo/src/a.js" } });
    expect(fromOpenCodeCall("apply_patch", { patchText: "*** src/a.js" })).toMatchObject({ tool: "apply_patch", input: { patch: "*** src/a.js" } });
    expect(fromOpenCodeCall("bifrost_bifrost_at", { path: "x" }).tool).toBe("bifrost_bifrost_at");
  });

  it("resolves places from Claude Code tool calls", () => {
    expect(placesFromToolCall("Read", { file_path: "/repo/src/a.js", offset: 10, limit: 5 }, root)).toEqual([{ path: "src/a.js", lines: [10, 15] }]);
    expect(placesFromToolCall("Edit", { file_path: "src/a.js" }, root)).toEqual([{ path: "src/a.js", lines: undefined }]);
    expect(placesFromToolCall("Read", { file_path: "/elsewhere/a.js" }, root)).toEqual([]);
    expect(placesFromToolCall("Bash", { command: "sed -n 1,20p src/a.js" }, root, ["src/a.js", "src/b.js"]).map((p: { path: string }) => p.path)).toEqual(["src/a.js"]);
    expect(placesFromToolCall("Glob", { pattern: "**/*.js", path: "/repo" }, root)).toEqual([]);
  });

  it("matches by path and narrows by line range", () => {
    const notes = [
      { id: "a", type: "warning", anchor: { path: "src/a.js", lines: [40, 60] }, text: "x" },
      { id: "b", type: "how-to", anchor: { path: "src/a.js" }, text: "y" },
      { id: "c", type: "decision", anchor: { path: "src/b.js" }, text: "z" },
    ];
    expect(matchNotes(notes, [{ path: "src/a.js", lines: [1, 20] }]).map((n: { id: string }) => n.id)).toEqual(["b"]);
    expect(matchNotes(notes, [{ path: "src/a.js" }]).map((n: { id: string }) => n.id)).toEqual(["a", "b"]);
  });

  it("formats within the note cap and character budget, warnings first", () => {
    const notes = loadNotes(HAND);
    const all = formatNotes(notes, { maxNotes: 3, budgetChars: 5000 });
    expect(all.shown).toEqual(["rr-1", "rr-2", "rr-3"]);
    expect(all.text.split("\n")[0]).toBe("BIFRÖST src/authClient.js › AuthClient.refreshSession");
    const tight = formatNotes(notes, { maxNotes: 3, budgetChars: 350 });
    expect(tight.shown).toEqual(["rr-1"]);
    expect(tight.text.length).toBeLessThanOrEqual(350);
  });

  it("sanitizes control characters and caps length", () => {
    expect(sanitize("a\u001b[31mb‮c", 280)).toBe("a[31mbc");
    expect(sanitize("x".repeat(400)).length).toBe(280);
  });
});

describe("opencode plugin", () => {
  it("appends notes to the tool result once, repeats warnings on edit, stays silent in control", async () => {
    const state = join(tmp, "oc-state");
    const env = { ...process.env };
    process.env.BIFROST_NOTES = HAND;
    process.env.BIFROST_STATE = state;
    process.env.BIFROST_LOG = join(tmp, "oc.jsonl");
    try {
      const hooks = await BifrostPlugin({ directory: "/ws", worktree: "/ws" });
      const call = async (tool: string, sessionID = "s1") => {
        const out = { title: "", output: "result", metadata: {} };
        await hooks["tool.execute.after"]({ tool, sessionID, callID: "c", args: { filePath: "/ws/src/authClient.js" } }, out);
        return out.output;
      };
      expect(await call("read")).toMatch(/^result\n\nBIFRÖST src\/authClient\.js[\s\S]*WARNING[\s\S]*HOW-TO/);
      expect(await call("read")).toBe("result");
      const edit = await call("edit");
      expect(edit).toContain("WARNING");
      expect(edit).not.toContain("HOW-TO");
      process.env.BIFROST_MODE = "noop";
      expect(await call("read", "s2")).toBe("result");
    } finally {
      process.env = env;
    }
  });
});

describe("hook", () => {
  const run = (event: object, env: Record<string, string>) =>
    spawnSync(process.execPath, [HOOK], { input: JSON.stringify(event), encoding: "utf8", env: { ...process.env, ...env } });

  it("injects notes once per session, repeats warnings on edit, and logs", () => {
    const dir = join(tmp, "hook1");
    mkdirSync(dir, { recursive: true });
    const env = { BIFROST_NOTES: HAND, BIFROST_LOG: join(dir, "log.jsonl"), BIFROST_STATE: join(dir, "state") };
    const read = { session_id: "s", cwd: "/ws", tool_name: "Read", tool_input: { file_path: "/ws/src/authClient.js" } };
    const first = run(read, env);
    expect(first.status).toBe(0);
    const ctx = JSON.parse(first.stdout).hookSpecificOutput;
    expect(ctx.hookEventName).toBe("PreToolUse");
    expect(ctx.additionalContext).toContain("WARNING");
    expect(run(read, env).stdout).toBe("");
    const edit = run({ ...read, tool_name: "Edit" }, env);
    expect(JSON.parse(edit.stdout).hookSpecificOutput.additionalContext).toContain("rotates refresh tokens");
    expect(run({ ...read, tool_name: "Edit" }, env).stdout).toBe("");
    const log = readFileSync(env.BIFROST_LOG, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(log.map((e) => e.shown)).toEqual([["rr-1", "rr-2"], [], ["rr-1"], []]);
  });

  it("stays silent in noop mode, without notes, and on bad input", () => {
    const read = { session_id: "s2", cwd: "/ws", tool_name: "Read", tool_input: { file_path: "/ws/src/authClient.js" } };
    expect(run(read, { BIFROST_NOTES: HAND, BIFROST_MODE: "noop" }).stdout).toBe("");
    expect(run(read, {}).stdout).toBe("");
    const bad = spawnSync(process.execPath, [HOOK], { input: "not json", encoding: "utf8" });
    expect(bad.status).toBe(0);
    expect(bad.stdout).toBe("");
  });
});

describe.each(["refresh-rotation", "refresh-rotation-undocumented", "refresh-rotation-buried", "refresh-rotation-vendor"])("%s task", (id) => {
  const dir = join(EXP, "tasks", id);
  const gradeWith = (variant: "original" | "naive" | "correct" | "generic") => {
    const ws = prepareWorkspace(loadTask(id));
    try {
      if (variant !== "original") cpSync(join(dir, "reference", variant, "src/authClient.js"), join(ws, "src/authClient.js"));
      return grade(loadTask(id), ws) as Record<string, unknown> & { details: Record<string, string> };
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  };

  it("the grader separates no fix, the naive retry and the correct fix", () => {
    const original = gradeWith("original");
    expect(original).toMatchObject({ visible: true, goal: false, pass: false, trapHit: false });
    const naive = gradeWith("naive");
    expect(naive).toMatchObject({ visible: true, goal: true, trapAvoided: false, pass: false, trapHit: true });
    expect(naive.details.trapAvoided).toContain("revoked the whole token family");
    const correct = gradeWith("correct");
    expect(correct).toMatchObject({ visible: true, goal: true, trapAvoided: true, failFast: true, pass: true, trapHit: false });
    // The vendor task's server ignores the standard header: the textbook fix is a trap too.
    if (existsSync(join(dir, "reference/generic"))) expect(gradeWith("generic")).toMatchObject({ goal: true, trapAvoided: false, trapHit: true });
  });

  it("keeps notes within 280 characters, anchored to files the agent gets", () => {
    const ws = prepareWorkspace(loadTask(id));
    try {
      for (const f of ["hand", "wrong"]) {
        for (const n of loadNotes(join(dir, `notes/${f}.json`))) {
          expect(n.text.length).toBeLessThanOrEqual(280);
          expect(existsSync(join(ws, n.anchor.path))).toBe(true);
        }
      }
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe("invoice-csv-taste task", () => {
  const dir = join(EXP, "tasks", "invoice-csv-taste");
  const gradeWith = (variant: "original" | "naive" | "correct") => {
    const ws = prepareWorkspace(loadTask("invoice-csv-taste"));
    try {
      if (variant !== "original") cpSync(join(dir, "reference", variant), ws, { recursive: true });
      return grade(loadTask("invoice-csv-taste"), ws) as Record<string, unknown> & { details: Record<string, string> };
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  };

  it("the grader separates no export, the repo's style and the team's style", () => {
    expect(gradeWith("original")).toMatchObject({ visible: true, goal: false, pass: false, trapHit: false });
    const naive = gradeWith("naive");
    expect(naive).toMatchObject({ visible: true, goal: true, pass: false, trapHit: true, styleFollowed: 0 });
    expect(naive.details.dates).toContain("2026-03-31");
    expect(gradeWith("correct")).toMatchObject({ visible: true, goal: true, pass: true, trapHit: false, styleFollowed: 5 });
  });

  it("keeps notes within 280 characters, anchored to files the agent gets", () => {
    const ws = prepareWorkspace(loadTask("invoice-csv-taste"));
    try {
      for (const f of ["hand", "wrong"]) {
        for (const n of loadNotes(join(dir, `notes/${f}.json`))) {
          expect(n.text.length).toBeLessThanOrEqual(280);
          expect(existsSync(join(ws, n.anchor.path))).toBe(true);
        }
      }
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("the repo says nothing about the team's conventions", () => {
    const ws = prepareWorkspace(loadTask("invoice-csv-taste"));
    try {
      const out = spawnSync("grep", ["-rliE", "semicolon|snake.?case|french|total_cents|issued_on|named export|join\\(\";\"\\)", ".", "--exclude-dir=.git"], { cwd: ws, encoding: "utf8" }).stdout;
      expect(out).toBe("");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

it("the undocumented variant has no trace of the trap in the repo; the buried one has it only in the vendor pages", () => {
  const scan = (id: string) => {
    const ws = prepareWorkspace(loadTask(id));
    try {
      const out = spawnSync("grep", ["-rliE", "reuse detection|token famil|rotates the refresh|keyline-retry-token", ".", "--exclude-dir=.git"], { cwd: ws, encoding: "utf8" }).stdout;
      return out.split("\n").filter(Boolean).map((p) => p.replace(/^\.\//, "")).sort();
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  };
  expect(scan("refresh-rotation-undocumented")).toEqual([]);
  // Idempotency-Key also appears in the payments code and docs, on purpose: it reads as a payments-only thing.
  expect(scan("refresh-rotation-vendor")).toEqual(["docs/vendor/keyline/changelog.md", "docs/vendor/keyline/request-headers.md", "docs/vendor/keyline/security.md"]);
  expect(scan("refresh-rotation-buried")).toEqual(["docs/vendor/keyline/changelog.md", "docs/vendor/keyline/request-headers.md", "docs/vendor/keyline/security.md"]);
});

const SAMPLE_TRACE = [
  { type: "system", subtype: "init" },
  { type: "user", message: { role: "user", content: "Fix the refresh bug" } },
  { type: "assistant", message: { content: [{ type: "text", text: "Reading." }, { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/ws/src/authClient.js" } }] } },
  { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "export class AuthClient {}" }] } },
  { type: "assistant", message: { content: [{ type: "tool_use", id: "t2", name: "Bash", input: { command: "API_KEY=sk-abcdefghijklmnopqrstuvwxyz npm test" } }] } },
  { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t2", content: "Error: 1 failing\nat test", is_error: true }] } },
  { type: "result", subtype: "success", total_cost_usd: 0.12, num_turns: 2 },
  { type: "bifrost.outcome", text: "a timeout that loses the response is handled safely: NO (family revoked)." },
]
  .map((o) => JSON.stringify(o))
  .join("\n");

describe("trace", () => {
  it("parses Claude stream-json with the appended outcome", () => {
    const steps = parseTrace(SAMPLE_TRACE, "Fix the refresh bug");
    expect(steps.map((s) => s.kind)).toEqual(["prompt", "assistant", "tool_call", "tool_result", "tool_call", "tool_result", "outcome"]);
  });

  it("renders full and digest forms with secrets removed", () => {
    const steps = parseTrace(SAMPLE_TRACE);
    const full = renderFull(steps);
    const digest = renderDigest(steps);
    for (const text of [full, digest]) {
      expect(text).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
      expect(text).toContain("family revoked");
    }
    expect(digest).toContain("- Bash: API_KEY=[secret] npm test → error: Error: 1 failing");
    expect(full).toContain("RESULT: export class AuthClient {}");
    expect(scrub("password: hunter2hunter2")).toBe("password: [secret]");
  });
});

describe("generator", () => {
  const repoFiles = listRepoFiles(join(TASK, "repo"));

  it("lists repository files", () => {
    expect(repoFiles).toContain("src/authClient.js");
    expect(repoFiles).toContain("docs/vendor/authserver-api.md");
  });

  it("validates model output: drops unknown paths, cuts long text, caps at 5", () => {
    const raw = {
      notes: [
        { type: "warning", path: "src/authClient.js", symbol: "AuthClient.refreshSession", text: "Keep the idempotency key across retries." },
        { type: "decision", path: "src/nope.js", symbol: null, text: "x" },
        { type: "how-to", path: "./src/transport.js", symbol: null, text: "y".repeat(300) },
      ],
    };
    const { notes, dropped } = validateNotes(raw, repoFiles);
    expect(notes.map((n) => n.anchor)).toEqual([{ path: "src/authClient.js", symbol: "AuthClient.refreshSession" }, { path: "src/transport.js" }]);
    expect(notes[1].text.length).toBe(280);
    expect(dropped.map((d) => d.reason)).toEqual(["path not in repository", "text cut to 280 characters"]);
    expect(() => validateNotes({ notes: [{ type: "gossip", path: "a", text: "b" }] }, repoFiles)).toThrow(/schema/);
  });

  it("sends the rendered trace to the model and returns a notes file", async () => {
    let seen = "";
    const result = await generateNotes({
      steps: parseTrace(SAMPLE_TRACE, "Fix the refresh bug"),
      repoFiles,
      input: "digest",
      source: "gen:test",
      call: async ({ user, schema }) => {
        seen = user;
        expect(schema.required).toEqual(["notes"]);
        return { json: { notes: [{ type: "warning", path: "src/authClient.js", symbol: null, text: "Don't retry refresh without an idempotency key." }] } };
      },
    });
    expect(seen).toContain("- src/authClient.js");
    expect(seen).toContain("outcome: a timeout that loses the response");
    expect(result.notes).toEqual([{ id: "gen-1", type: "warning", anchor: { path: "src/authClient.js" }, text: "Don't retry refresh without an idempotency key.", author: "generated", age: "" }]);
  });
});

describe("harness", () => {
  const task = loadTask("refresh-rotation");
  const base: RunOptions = { agent: "claude", timeoutMs: 60_000, settingSources: "project", extraArgs: [], keep: false };

  it("resolves arms", () => {
    expect(resolveArm("hand")).toMatchObject({ push: "inject", notes: "hand" });
    expect(resolveArm("gen:gen-opus-full")).toMatchObject({ push: "inject", notes: "gen-opus-full" });
    expect(resolveArm("pull:hand")).toMatchObject({ push: "noop", pull: true });
    expect(() => resolveArm("bogus")).toThrow(/unknown arm/);
  });

  it("builds an isolated Claude Code command", () => {
    const runDir = join(tmp, "cmd");
    mkdirSync(runDir, { recursive: true });
    const { cmd, args } = buildAgentCommand(task, resolveArm("hand-pull"), { ...base, model: "claude-sonnet-5", budgetUsd: 2 }, { ws: "/ws", runDir, notesFile: "/n.json", env: { BIFROST_LOG: "/l" } });
    expect(cmd).toBe("claude");
    expect(args).toEqual(expect.arrayContaining(["-p", "--output-format", "stream-json", "--strict-mcp-config", "--setting-sources", "project", "--model", "claude-sonnet-5", "--max-budget-usd", "2", "--append-system-prompt"]));
    const mcp = JSON.parse(readFileSync(join(runDir, "mcp.json"), "utf8"));
    expect(mcp.mcpServers.bifrost.env).toMatchObject({ BIFROST_NOTES: "/n.json", BIFROST_ROOT: "/ws" });
    const settings = JSON.parse(readFileSync(join(runDir, "settings.json"), "utf8"));
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toContain("hook.mjs");
  });

  it("builds an OpenCode command with config in the environment, not the workspace", () => {
    const runDir = join(tmp, "cmd3");
    mkdirSync(runDir, { recursive: true });
    const env: Record<string, string> = { BIFROST_LOG: "/l" };
    const { cmd, args } = buildAgentCommand(task, resolveArm("hand-pull"), { ...base, agent: "opencode", model: "openrouter/qwen" }, { ws: "/ws", runDir, notesFile: "/n.json", env });
    expect(cmd).toBe("opencode");
    expect(args.slice(0, 5)).toEqual(["run", "--format", "json", "--dir", "/ws"]);
    expect(args).toEqual(expect.arrayContaining(["--model", "openrouter/qwen", task.prompt]));
    const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
    expect(config.plugin[0]).toMatch(/^file:.*opencode-plugin\.mjs$/);
    expect(config.mcp.bifrost.environment).toMatchObject({ BIFROST_NOTES: "/n.json", BIFROST_ROOT: "/ws" });
    expect(readFileSync(config.instructions[0], "utf8")).toContain("bifrost_at");
    expect(config.permission.external_directory).toBe("deny");
    const off = { BIFROST_LOG: "/l" } as Record<string, string>;
    buildAgentCommand(task, resolveArm("none"), { ...base, agent: "opencode" }, { ws: "/ws", runDir, env: off });
    expect(JSON.parse(off.OPENCODE_CONFIG_CONTENT).plugin).toBeUndefined();
  });

  it("tells brief arms what pushed notes are, and no one else", () => {
    const runDir = join(tmp, "cmd4");
    mkdirSync(runDir, { recursive: true });
    const env: Record<string, string> = { BIFROST_LOG: "/l" };
    buildAgentCommand(task, resolveArm("hand-brief"), { ...base, agent: "opencode" }, { ws: "/ws", runDir, notesFile: "/n.json", env });
    const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
    expect(config.plugin).toHaveLength(1);
    expect(config.mcp).toBeUndefined();
    expect(readFileSync(config.instructions[0], "utf8")).toContain("BIFRÖST");
    const plain: Record<string, string> = { BIFROST_LOG: "/l" };
    buildAgentCommand(task, resolveArm("hand"), { ...base, agent: "opencode" }, { ws: "/ws", runDir, notesFile: "/n.json", env: plain });
    expect(JSON.parse(plain.OPENCODE_CONFIG_CONTENT).instructions).toBeUndefined();
    const { args } = buildAgentCommand(task, resolveArm("hand-brief"), base, { ws: "/ws", runDir, notesFile: "/n.json", env: { BIFROST_LOG: "/l" } });
    expect(args[args.indexOf("--append-system-prompt") + 1]).toContain("BIFRÖST");
  });

  it("reads OpenCode traces: steps, paths, summed cost and tokens", () => {
    const ev = (type: string, part: object) => JSON.stringify({ type, timestamp: 1, sessionID: "ses_1", part });
    const text = [
      ev("step_start", { type: "step-start" }),
      ev("tool_use", { type: "tool", tool: "read", callID: "c1", state: { status: "completed", input: { filePath: "/ws/src/authClient.js" }, output: "body" } }),
      ev("step_finish", { type: "step-finish", cost: 0.01, tokens: { input: 100, output: 10, reasoning: 5, cache: { read: 50, write: 0 } } }),
      ev("tool_use", { type: "tool", tool: "edit", callID: "c2", state: { status: "error", input: { filePath: "/ws/src/authClient.js", oldString: "a", newString: "b" }, error: "no match" } }),
      ev("text", { type: "text", text: "Done." }),
      ev("step_finish", { type: "step-finish", cost: 0.02, tokens: { input: 200, output: 20, reasoning: 0, cache: { read: 0, write: 0 } } }),
    ].join("\n");
    const steps = parseTrace(text);
    expect(steps.map((s) => s.kind)).toEqual(["tool_call", "tool_result", "tool_call", "tool_result", "assistant"]);
    expect(steps[2]).toMatchObject({ tool: "Edit", input: { file_path: "/ws/src/authClient.js", old_string: "a" } });
    expect(steps[3]).toMatchObject({ isError: true, text: "no match" });
    const m = metricsFromTrace(text, "/ws");
    expect(m).toMatchObject({ numTurns: 2, inputTokens: 300, outputTokens: 35, cacheReadTokens: 50, toolCalls: 2, readPaths: ["src/authClient.js"] });
    expect(m.costUsd).toBeCloseTo(0.03);
  });

  it("marks runs where the agent never started as invalid, and the report leaves them out", () => {
    const blocked = JSON.stringify({ type: "error", sessionID: "s", error: { name: "APIError", data: { message: "Forbidden: host not allowed" } } });
    expect(invalidReason(blocked, 1, 0)).toBe("agent error: Forbidden: host not allowed");
    expect(invalidReason("", 1, 0)).toMatch(/exited with code 1/);
    expect(invalidReason(blocked, 1, 3)).toBeUndefined();
    expect(invalidReason("", 0, 0)).toBeUndefined();
    const t0 = 1_790_000_000_000;
    const at = (ms: number) => JSON.stringify({ type: "tool_use", timestamp: t0 + ms, sessionID: "s", part: {} });
    const run = { timedOut: true, startMs: t0, durationMs: 20 * 60_000 };
    expect(invalidReason(at(60_000), null, 1, run)).toMatch(/stalled: no agent event for the last 19 min/);
    expect(invalidReason(at(18 * 60_000), null, 1, run)).toBeUndefined();
    expect(invalidReason("", null, 0, run)).toMatch(/no response from the model/);
    const row = { task: "t", arm: "control", rep: 1, pass: false, trapHit: false, goal: false, durationMs: 1, notesShown: [], pullCalls: 0, readPaths: [] } as unknown as Parameters<typeof buildReport>[0][number];
    const report = buildReport([row, { ...row, rep: 2, invalid: "agent error: Forbidden" }]);
    expect(report).toContain("1 invalid run(s) left out");
    expect(report).toContain("| control | 1 |");
  });

  it("refuses push arms for codex", () => {
    const runDir = join(tmp, "cmd2");
    mkdirSync(runDir, { recursive: true });
    expect(() => buildAgentCommand(task, resolveArm("hand"), { ...base, agent: "codex" }, { ws: "/ws", runDir, env: { BIFROST_LOG: "/l" } })).toThrow(/codex/);
  });

  it("runs, grades and measures a scripted agent end to end", async () => {
    const out = join(tmp, "results");
    const opts: RunOptions = { ...base, agent: "command", agentCmd: `"${process.execPath}" "${join(EXP, "harness/fake-agent.mjs")}" {workspace} {runDir}` };
    const control = await runOne(task, resolveArm("control"), 1, opts, out);
    const hand = await runOne(task, resolveArm("hand"), 1, opts, out);
    expect(control).toMatchObject({ pass: false, trapHit: true, notesShown: [], costUsd: 0.5, numTurns: 3, toolCalls: 2 });
    expect(hand).toMatchObject({ pass: true, trapHit: false, notesShown: ["rr-1", "rr-2"], pushDeliveries: 1 });
    const trace = readFileSync(join(control.runDir, "trace.jsonl"), "utf8").trim().split("\n");
    expect(JSON.parse(trace[trace.length - 1]).text).toContain("a timeout that loses the response is handled safely: NO");
    const report = buildReport([control, hand]);
    expect(report).toContain("| hand | 1 | 100% | 0% |");
  });

  it("describes a grade in the task's own words", () => {
    const text = outcomeText({ visible: true, goal: false, details: { goal: "signed out" } }, { command: [], labels: { visible: "tests pass", goal: "blip survived" } });
    expect(text).toBe("After the session the change was graded. tests pass: yes. blip survived: NO (signed out).");
  });
});

describe("report statistics", () => {
  it("bootstraps a difference with an interval around it", () => {
    const a = [0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
    const b = [1, 1, 1, 1, 0, 1, 1, 1, 1, 1];
    const d = bootstrapDiff(a, b, (xs) => xs.reduce((x, y) => x + y, 0) / xs.length);
    expect(d.point).toBeCloseTo(0.7);
    expect(d.low).toBeGreaterThan(0);
    expect(d.high).toBeLessThanOrEqual(1);
  });

  it("does not credit an arm for failing faster", () => {
    const row = (arm: string, rep: number, pass: boolean, durationMs: number) =>
      ({ task: "t", arm, rep, pass, trapHit: false, goal: pass, durationMs, notesShown: [], pullCalls: 0, readPaths: [] }) as unknown as Parameters<typeof buildReport>[0][number];
    const reps = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const report = buildReport([...reps.map((i) => row("control", i, false, 200_000 + i)), ...reps.map((i) => row("wrong", i, false, 100_000 + i))]);
    expect(report).toContain("≥15% faster, but never passes");
    expect(report).not.toContain("meets the bar");
  });

  it("writes nothing it cannot compute", () => {
    writeFileSync(join(tmp, "empty.jsonl"), "");
    expect(buildReport([], "control")).toContain("Runs: 0.");
  });
});
