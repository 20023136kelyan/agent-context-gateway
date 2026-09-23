/**
 * Proactive context (src/proactive.ts) and its Claude Code hook. The gate is a
 * fake Jev client: which candidates it approves is the behaviour under test.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createApp, closeApp, type GatewayApp } from "../src/app.js";
import { syncNow } from "../src/commands.js";
import { proactiveContext, isTrivialPrompt, excerptAround } from "../src/proactive.js";
import type { JevClient } from "../src/judgments/jev.js";

const line = (o: object) => JSON.stringify(o);
function claudeSession(dir: string, id: string, cwd: string, ts: string, request: string, reply: string, edit?: string) {
  mkdirSync(dir, { recursive: true });
  const lines = [
    line({ type: "user", uuid: `${id}-u`, sessionId: id, cwd, timestamp: ts, message: { role: "user", content: request } }),
    line({ type: "assistant", uuid: `${id}-a`, sessionId: id, cwd, timestamp: ts, message: { role: "assistant", content: [
      { type: "text", text: reply },
      ...(edit ? [{ type: "tool_use", id: `${id}-t`, name: "Edit", input: { file_path: `${cwd}/${edit}`, old_string: "a", new_string: "b" } }] : []),
    ] } }),
  ];
  writeFileSync(join(dir, `${id}.jsonl`), lines.join("\n"));
}

/** Approves a candidate when its excerpt contains `approve`; records what it was asked. */
function fakeGate(approve: string, p = 0.9): JevClient & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    noul: async (state: unknown) => {
      const s = state as { candidate: string };
      asked.push(s.candidate);
      return { answers: { helps: s.candidate.includes(approve) ? p : 0.1 } };
    },
  } as unknown as JevClient & { asked: string[] };
}

let root: string;
let app: GatewayApp;
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "acg-proactive-"));
  const app1 = join(root, "claude", "-Users-alice-app");
  claudeSession(app1, "s-rate", "/Users/alice/app", "2026-09-01T10:00:00Z",
    "Add rate limiting to the api client", "Rate limiting added with a token bucket in src/api/limits.ts", "src/api/limits.ts");
  claudeSession(app1, "s-style", "/Users/alice/app", "2026-09-02T10:00:00Z",
    "Restyle the api client docs page", "Restyled the docs page for the api client");
  claudeSession(app1, "s-self", "/Users/alice/app", "2026-09-05T10:00:00Z",
    "The api client rate limiting drops requests", "Looking into it");
  const other = join(root, "claude", "-Users-alice-other");
  claudeSession(other, "s-other", "/Users/alice/other", "2026-09-03T10:00:00Z",
    "Add rate limiting to the api client in other", "Rate limiting done in other");
  const dead = (n: string) => {
    const d = join(root, n);
    mkdirSync(d, { recursive: true });
    return d;
  };
  app = createApp({
    stateDir: join(root, "state"), claudeDir: join(root, "claude"), codexDir: dead("codex"), indexDir: join(root, "index"),
    cursorDb: dead("cursor"), zepDir: dead("zep"), opencodeDb: dead("opencode"), trajectoryDir: dead("traj"), gitRepos: [],
  });
  await syncNow(app);
});
afterAll(() => {
  closeApp(app);
  rmSync(root, { recursive: true, force: true });
});

const ask = { prompt: "The api client rate limiting drops requests under load", project: "app", sessionId: "s-self" };

describe("proactiveContext", () => {
  it("skips slash commands and prompts with no content", () => {
    for (const p of ["ok", "continue", "/clear", "yes please do"]) expect(isTrivialPrompt(p)).toBe(true);
    expect(isTrivialPrompt(ask.prompt)).toBe(false);
  });

  it("injects only what the gate approves, from the caller's project, never its own session", async () => {
    const gate = fakeGate("token bucket");
    const res = await proactiveContext(app, ask, { gate, remember: false });
    expect(res.items.map((i) => i.sessionId)).toEqual(["s-rate"]);
    expect(res.text).toContain("s-rate".slice(0, 8));
    expect(res.text).toContain("context.get_context");
    // The other project's identical request, and the caller's own session, are never candidates.
    expect(gate.asked.some((c) => c.includes("in other"))).toBe(false);
    expect(gate.asked.some((c) => c.includes("Looking into it"))).toBe(false);
  });

  it("stays silent when the gate is not confident", async () => {
    const res = await proactiveContext(app, ask, { gate: fakeGate("token bucket", 0.6), threshold: 0.7, remember: false });
    expect(res.items).toEqual([]);
    expect(res.text).toBe("");
  });

  it("without a judge, offers no search results but still states exact edits", async () => {
    const silent = await proactiveContext(app, ask, { gate: null, remember: false });
    expect(silent.items).toEqual([]);
    const named = await proactiveContext(app, { ...ask, prompt: "Why does src/api/limits.ts drop requests under load?" }, { gate: null, remember: false });
    expect(named.items).toMatchObject([{ via: "action", sessionId: "s-rate" }]);
    expect(named.items[0].line).toContain("src/api/limits.ts");
  });

  it("does not repeat an injection within the same session", async () => {
    const first = await proactiveContext(app, { ...ask, sessionId: "s-new" }, { gate: fakeGate("token bucket") });
    expect(first.items).toHaveLength(1);
    const again = await proactiveContext(app, { ...ask, sessionId: "s-new" }, { gate: fakeGate("token bucket") });
    expect(again.items).toEqual([]);
  });
});

describe("excerptAround: what the gate reads", () => {
  // Reading the window from its start handed Jev the turns BEFORE the match;
  // in a long session that was all it saw (a session that did exactly the
  // asked-about work scored p = 0.15; centred, 0.83).
  const long = (id: string, word: string) => ({ id, role: "assistant", content: `${word} `.repeat(40) });
  const window = [long("a", "setup"), long("b", "noise"), long("hit", "scrubbing"), long("d", "after"), long("e", "later")];

  it("starts with the matching turn, then its nearest neighbours", () => {
    const x = excerptAround(window, "hit");
    expect(x.startsWith("assistant: scrubbing")).toBe(true);
    // Nearest first: after (+1), noise (-1), later (+2), then setup (-2) with what budget is left.
    const at = (w: string) => x.indexOf(`assistant: ${w}`);
    expect([at("after"), at("noise"), at("later")].every((i, k, a) => i > 0 && (k === 0 || i > a[k - 1]))).toBe(true);
    expect(at("setup") === -1 || at("setup") > at("later")).toBe(true);
  });

  it("stays within its budget and falls back to the first turn when the centre is missing", () => {
    expect(excerptAround(window, "hit").length).toBeLessThanOrEqual(1200);
    expect(excerptAround(window, "nope").startsWith("assistant: setup")).toBe(true);
  });
});

describe("hook-prompt command", () => {
  const run = (stdin: string) =>
    spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "hook-prompt", "--budget-ms", "20000"], {
      input: stdin,
      encoding: "utf8",
      env: { ...process.env, CONTEXT_GATEWAY_STATE: join(root, "hook-state"), JEV_ENDPOINT: "http://127.0.0.1:1/off", TYPESAFE_API_KEY: "" },
      timeout: 60000,
    });

  it("exits 0 with no output on input it cannot use: it must never block a prompt", () => {
    for (const stdin of ["not json", "{}", JSON.stringify({ prompt: "ok", cwd: "/nowhere" })]) {
      const r = run(stdin);
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe("");
    }
  });
});
