/**
 * History locations: one answer for sync, init and the watcher, on every OS,
 * honouring each harness's own relocation variable. The last test is the
 * user-visible bug this fixes: `init` for someone who only uses OpenCode.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  claudeProjectsDir,
  claudeSettingsPath,
  codexSessionsDir,
  cursorDirs,
  opencodeDbPath,
  detectHistories,
  watchTargets,
} from "../src/adapters/locations.js";
import { ClaudeAdapter } from "../src/adapters/claude.js";
import { CodexAdapter } from "../src/adapters/codex.js";
import { watchSources } from "../src/watch.js";
import type { GatewayApp } from "../src/app.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

const tmp = () => mkdtempSync(join(tmpdir(), "acg-loc-"));
/** An env with nothing relocated: only HOME, so the host's variables cannot leak in. */
const bare = (home: string): NodeJS.ProcessEnv => ({ HOME: home });

function opencodeDb(path: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE project (id TEXT, name TEXT);
    CREATE TABLE session (id TEXT, project_id TEXT, directory TEXT, title TEXT);
    CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
    CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);`);
  db.prepare("INSERT INTO project VALUES (?, ?)").run("p1", "demo");
  db.prepare("INSERT INTO session VALUES (?, ?, ?, ?)").run("ses_1", "p1", "/repo/demo", "first chat");
  db.prepare("INSERT INTO message VALUES (?, ?, ?, ?)").run("m1", "ses_1", 1000, JSON.stringify({ role: "user" }));
  db.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?)").run("pt1", "m1", "ses_1", 1001, JSON.stringify({ type: "text", text: "why does the flaky websocket test time out?" }));
  db.close();
}

afterEach(() => vi.unstubAllEnvs());

describe("history locations", () => {
  it("uses each harness's standard folder by default", () => {
    const env = bare("/h");
    expect(claudeProjectsDir(env)).toBe(join("/h", ".claude", "projects"));
    expect(claudeSettingsPath(env)).toBe(join("/h", ".claude", "settings.json"));
    expect(codexSessionsDir(env)).toBe(join("/h", ".codex", "sessions"));
    expect(opencodeDbPath(env)).toBe(join("/h", ".local", "share", "opencode", "opencode.db"));
  });

  it("finds Cursor where each OS keeps application data", () => {
    const env = bare("/h");
    expect(cursorDirs(env, "darwin").globalDb).toBe(join("/h", "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb"));
    expect(cursorDirs(env, "linux").globalDb).toBe(join("/h", ".config", "Cursor", "User", "globalStorage", "state.vscdb"));
    expect(cursorDirs({ ...env, XDG_CONFIG_HOME: "/x" }, "linux").globalDb).toBe(join("/x", "Cursor", "User", "globalStorage", "state.vscdb"));
    expect(cursorDirs({ ...env, APPDATA: "C:/Users/u/AppData/Roaming" }, "win32").workspaceRoot).toBe(
      join("C:/Users/u/AppData/Roaming", "Cursor", "User", "workspaceStorage"),
    );
  });

  it("follows the harnesses' own relocation variables", () => {
    const env = { ...bare("/h"), CLAUDE_CONFIG_DIR: "/c", CODEX_HOME: "/x", XDG_DATA_HOME: "/d" };
    expect(claudeProjectsDir(env)).toBe(join("/c", "projects"));
    expect(claudeSettingsPath(env)).toBe(join("/c", "settings.json"));
    expect(codexSessionsDir(env)).toBe(join("/x", "sessions"));
    expect(opencodeDbPath(env)).toBe(join("/d", "opencode", "opencode.db"));
    expect(opencodeDbPath({ ...env, GATEWAY_OPENCODE_DB: "/o.db" })).toBe("/o.db");
    const via = Object.fromEntries(detectHistories(env, "darwin").map((s) => [s.kind, s.via]));
    expect(via).toMatchObject({ "claude-code": "CLAUDE_CONFIG_DIR", codex: "CODEX_HOME", opencode: "XDG_DATA_HOME" });
  });

  it("detects every harness init can sync, and only what is really there", () => {
    const home = tmp();
    const kinds = (env: NodeJS.ProcessEnv) =>
      detectHistories(env, "linux").filter((s) => s.present).map((s) => s.kind);
    expect(detectHistories(bare(home), "linux").map((s) => s.kind)).toEqual(["claude-code", "codex", "opencode", "cursor", "trajectory"]);
    expect(kinds(bare(home))).toEqual([]);

    opencodeDb(opencodeDbPath(bare(home)));
    expect(kinds(bare(home))).toEqual(["opencode"]);

    mkdirSync(join(home, ".config", "Cursor", "User", "globalStorage"), { recursive: true });
    writeFileSync(join(home, ".config", "Cursor", "User", "globalStorage", "state.vscdb"), "");
    expect(kinds(bare(home))).toEqual(["opencode", "cursor"]);

    // An empty trajectory folder is not a history; one file in it is.
    const traj = join(home, "state", "trajectories");
    mkdirSync(traj, { recursive: true });
    const withTraj = { ...bare(home), GATEWAY_TRAJECTORY_DIR: traj };
    expect(kinds(withTraj)).toEqual(["opencode", "cursor"]);
    writeFileSync(join(traj, "run-1.jsonl"), "{}\n");
    expect(kinds(withTraj)).toEqual(["opencode", "cursor", "trajectory"]);
  });

  it("the adapters read the relocated folders too, not just init", async () => {
    const claudeHome = tmp();
    const codexHome = tmp();
    const sid = "11111111-2222-3333-4444-555555555555";
    mkdirSync(join(claudeHome, "projects", "-repo"), { recursive: true });
    writeFileSync(
      join(claudeHome, "projects", "-repo", `${sid}.jsonl`),
      JSON.stringify({ type: "user", sessionId: sid, uuid: "u1", timestamp: "2026-09-20T10:00:00Z", cwd: "/repo", message: { role: "user", content: "hello" } }) + "\n",
    );
    const day = join(codexHome, "sessions", "2026", "09", "20");
    mkdirSync(day, { recursive: true });
    writeFileSync(
      join(day, "rollout-2026-09-20T10-00-00-abc.jsonl"),
      [
        { type: "session_meta", payload: { id: "abc", timestamp: "2026-09-20T10:00:00Z", cwd: "/repo" } },
        { type: "response_item", timestamp: "2026-09-20T10:00:01Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] } },
      ].map((l) => JSON.stringify(l)).join("\n") + "\n",
    );
    vi.stubEnv("CLAUDE_CONFIG_DIR", claudeHome);
    vi.stubEnv("CODEX_HOME", codexHome);
    expect((await new ClaudeAdapter().listSessions()).map((s) => s.id)).toEqual([sid]);
    expect((await new CodexAdapter().listSessions()).length).toBe(1);
  });

  it("the watcher follows SQLite stores through their -wal files, and skips harnesses that are absent", () => {
    const env = bare("/h");
    const t = Object.fromEntries(watchTargets(env, "linux").map((w) => [w.harness, w]));
    expect(t.opencode.dir).toBe(join("/h", ".local", "share", "opencode"));
    expect(["opencode.db", "opencode.db-wal", "opencode.db-journal"].every(t.opencode.matches)).toBe(true);
    expect(["other.db", "opencode.json", "storage/x.json"].some(t.opencode.matches)).toBe(false);
    expect(t.cursor.matches("state.vscdb-wal")).toBe(true);
    expect(t.cursor.matches("storage.json")).toBe(false);
    expect(t.trajectory.matches("run.json") && t.trajectory.matches("run.jsonl")).toBe(true);
    expect(t["claude-code"].matches("notes.txt")).toBe(false);

    // Nothing installed: no watchers and no errors, rather than one error per harness.
    const home = tmp();
    vi.stubEnv("HOME", home);
    vi.stubEnv("CLAUDE_CONFIG_DIR", "");
    vi.stubEnv("CODEX_HOME", "");
    vi.stubEnv("XDG_DATA_HOME", "");
    vi.stubEnv("XDG_CONFIG_HOME", "");
    vi.stubEnv("GATEWAY_OPENCODE_DB", "");
    vi.stubEnv("GATEWAY_TRAJECTORY_DIR", join(home, "no-trajectories"));
    const errors: unknown[] = [];
    const ws = watchSources({} as GatewayApp, { onError: (e) => errors.push(e) });
    expect(ws).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("init works for someone who only uses OpenCode", () => {
    const home = tmp();
    opencodeDb(join(home, ".local", "share", "opencode", "opencode.db"));
    // No VITEST, no keys, no relocations from the host: a stranger's machine.
    const env = {
      PATH: process.env.PATH,
      HOME: home,
      CONTEXT_GATEWAY_STATE: join(home, ".context-gateway"),
      JEV_ENDPOINT: "http://127.0.0.1:1/off",
    };
    const cli = (...args: string[]) =>
      spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], { encoding: "utf8", env, cwd: process.cwd(), timeout: 60000 });
    const r = cli("init", "--yes", "--no-hooks", "--no-backfill");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("histories: opencode");
    expect(r.stdout).toContain('\\"turnsIndexed\\":1');
    expect(r.stdout).toContain('\\"sessions\\":{\\"opencode\\":1}');
    // And the conversation is findable afterwards.
    const found = cli("search", "flaky websocket test", "--all-projects", "--json");
    expect(found.status, found.stderr).toBe(0);
    expect(found.stdout).toContain('"harness": "opencode"');
  });

  it("init says where it looked when there is nothing", () => {
    const home = tmp();
    const r = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "init", "--yes", "--no-hooks", "--no-backfill"], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: home, CONTEXT_GATEWAY_STATE: join(home, ".context-gateway") },
      timeout: 60000,
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(join(home, ".local", "share", "opencode", "opencode.db"));
    expect(r.stderr).toContain("CODEX_HOME");
  });
});
