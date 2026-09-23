/**
 * `acg paths`: an agent (or person) points the gateway at histories kept
 * somewhere unusual, and everything that reads histories follows.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { changePaths, unsetPaths, listPaths } from "../src/paths.js";
import { createApp, closeApp } from "../src/app.js";
import { listSources, syncNow, getTurn } from "../src/commands.js";
import { watchTargets } from "../src/adapters/locations.js";

const tmp = () => mkdtempSync(join(tmpdir(), "acg-paths-"));

function claudeSession(projects: string, id: string, text: string) {
  mkdirSync(join(projects, "-repo"), { recursive: true });
  writeFileSync(
    join(projects, "-repo", `${id}.jsonl`),
    JSON.stringify({ type: "user", sessionId: id, uuid: `u-${id}`, timestamp: "2026-09-20T10:00:00Z", cwd: "/repo", message: { role: "user", content: text } }) + "\n",
  );
}

function codexSession(sessions: string, id: string, text: string) {
  const day = join(sessions, "2026", "09", "20");
  mkdirSync(day, { recursive: true });
  writeFileSync(
    join(day, `rollout-2026-09-20T10-00-00-${id}.jsonl`),
    [
      { type: "session_meta", payload: { id, timestamp: "2026-09-20T10:00:00Z", cwd: "/repo" } },
      { type: "response_item", timestamp: "2026-09-20T10:00:01Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } },
    ].map((l) => JSON.stringify(l)).join("\n") + "\n",
  );
}

const A = "aaaaaaaa-0000-0000-0000-000000000001";
const B = "bbbbbbbb-0000-0000-0000-000000000002";

let home: string;
let state: string;
beforeEach(() => {
  // A stranger's machine: nothing in the usual places, nothing relocated.
  home = tmp();
  state = join(home, ".context-gateway");
  vi.stubEnv("HOME", home);
  for (const v of ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "XDG_DATA_HOME", "XDG_CONFIG_HOME", "GATEWAY_OPENCODE_DB", "GATEWAY_TRAJECTORY_DIR"]) vi.stubEnv(v, "");
  vi.stubEnv("CONTEXT_GATEWAY_STATE", state);
});
afterEach(() => vi.unstubAllEnvs());

describe("acg paths", () => {
  it("set: checks the location, accepts the parent folder, and sync reads from it", async () => {
    const elsewhere = join(tmp(), "claude-profile");
    claudeSession(join(elsewhere, "projects"), A, "the websocket reconnect loop spins after a 401");

    const res = await changePaths("set", "claude-code", [elsewhere], { stateDir: state });
    expect(res.paths).toEqual([{ path: join(elsewhere, "projects"), sessions: 1 }]);
    expect(JSON.parse(readFileSync(join(state, "settings.json"), "utf8")).historyPaths).toEqual({ "claude-code": [join(elsewhere, "projects")] });

    const row = (await listPaths()).find((r) => r.kind === "claude-code")!;
    expect(row).toMatchObject({ path: join(elsewhere, "projects"), via: "acg paths", present: true, sessions: 1 });

    const app = createApp({ stateDir: state, indexDir: join(state, "index"), backend: "sqlite" });
    try {
      expect((await listSources(app)).find((s) => s.harness === "claude-code")?.sessions).toBe(1);
      expect((await syncNow(app, false, {})).turnsIndexed).toBe(1);
    } finally {
      await closeApp(app);
    }
    // The watcher follows the saved location too.
    expect(watchTargets().find((t) => t.harness === "claude-code")?.dir).toBe(join(elsewhere, "projects"));
  });

  it("refuses a location with no sessions, saving nothing, unless forced", async () => {
    const empty = tmp();
    await expect(changePaths("set", "codex", [empty], { stateDir: state })).rejects.toThrow(/no codex sessions were found/);
    await expect(changePaths("set", "codex", [join(empty, "missing")], { stateDir: state })).rejects.toThrow(/not found/);
    expect(existsSync(join(state, "settings.json"))).toBe(false);
    const forced = await changePaths("set", "codex", [empty], { stateDir: state, force: true });
    expect(forced.paths).toEqual([{ path: empty, sessions: 0 }]);
    await expect(changePaths("set", "claude", [empty], { stateDir: state })).rejects.toThrow(/unknown harness "claude"/);
  });

  it("add: reads the default location and the added one together, each session once", async () => {
    claudeSession(join(home, ".claude", "projects"), A, "live profile: flaky test in ci");
    const archive = join(tmp(), "archive", "projects");
    claudeSession(archive, B, "archive: the migration was rolled back");
    claudeSession(archive, A, "an older copy of the live session");

    const res = await changePaths("add", "claude-code", [archive], { stateDir: state });
    expect(res.paths.map((p) => p.path)).toEqual([join(home, ".claude", "projects"), archive]);

    const app = createApp({ stateDir: state, indexDir: join(state, "index"), backend: "sqlite" });
    try {
      expect((await listSources(app)).find((s) => s.harness === "claude-code")?.sessions).toBe(2);
      // Session A comes from the first location (the live one), not the archive's copy.
      const claude = app.adapters.find((a) => a.harness === "claude-code")!;
      const [a] = await claude.listTurns(A);
      const [b] = await claude.listTurns(B);
      expect(a!.content).toContain("live profile");
      expect(b!.content).toContain("rolled back");
      // Direct retrieval routes to the location that owns the session.
      expect((await getTurn(app, "claude-code", B, b!.id)).content).toContain("rolled back");
    } finally {
      await closeApp(app);
    }
  });

  it("unset: forgets one location, or all of them", async () => {
    const one = join(tmp(), "projects");
    const two = join(tmp(), "projects");
    claudeSession(one, A, "one");
    claudeSession(two, B, "two");
    await changePaths("set", "claude-code", [one, two], { stateDir: state });
    expect(unsetPaths("claude-code", one, { stateDir: state })).toEqual([two]);
    expect(() => unsetPaths("claude-code", one, { stateDir: state })).toThrow(/not a saved/);
    expect(unsetPaths("claude-code", undefined, { stateDir: state })).toEqual([]);
    expect((await listPaths()).find((r) => r.kind === "claude-code")?.via).toBe("default");
  });

  it("says when the gateway's own variable overrides what was saved", async () => {
    const db = join(tmp(), "opencode.db");
    writeFileSync(db, "");
    vi.stubEnv("GATEWAY_OPENCODE_DB", "/elsewhere/opencode.db");
    const res = await changePaths("set", "opencode", [db], { stateDir: state, force: true });
    expect(res.shadowedBy).toBe("GATEWAY_OPENCODE_DB");
  });

  it("an agent can run init against a Codex history kept somewhere unusual, then find it", () => {
    const unusual = join(tmp(), "backups", "codex-home");
    codexSession(join(unusual, "sessions"), "019a0000-0000-7000-8000-000000000001", "pin the tantivy version because 0.22 broke the tokenizer");
    const env = { PATH: process.env.PATH, HOME: home, CONTEXT_GATEWAY_STATE: state, JEV_ENDPOINT: "http://127.0.0.1:1/off" };
    const cli = (...args: string[]) =>
      spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], { encoding: "utf8", env, timeout: 60000 });

    const bad = cli("init", "--yes", "--no-hooks", "--no-backfill", "--path", `codex=${join(home, "nope")}`);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain("not found");

    const r = cli("init", "--yes", "--no-hooks", "--no-backfill", "--path", `codex=${unusual}`);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(`paths: codex += ${join(unusual, "sessions")}`);
    expect(r.stdout).toContain('\\"sessions\\":{\\"codex\\":1}');

    const shown = cli("paths");
    expect(shown.stdout).toMatch(new RegExp(`codex\\s+1 session\\s+${join(unusual, "sessions").replace(/[/.]/g, "\\$&")}\\s+\\(acg paths\\)`));
    const found = cli("search", "tantivy tokenizer", "--all-projects", "--json");
    expect(found.stdout).toContain('"harness": "codex"');
  });
});
