/**
 * Where each harness keeps its history on this machine: the one answer shared
 * by the adapters (what sync reads), `init`/`doctor` (what they report) and
 * the watcher (what it follows). Before this existed, init and the watcher
 * kept their own copies and knew only Claude Code and Codex, so an OpenCode-
 * or Cursor-only user was told "no agent histories found".
 *
 * Each harness's own relocation variable is honoured, the way the harness
 * itself does: CLAUDE_CONFIG_DIR (Claude Code), CODEX_HOME (Codex),
 * XDG_DATA_HOME (OpenCode), and the per-OS application-data folder (Cursor,
 * an Electron app). GATEWAY_OPENCODE_DB and GATEWAY_TRAJECTORY_DIR still win.
 */
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Harness } from "../core/models.js";

type Env = NodeJS.ProcessEnv;

const homeOf = (env: Env) => env.HOME || env.USERPROFILE || homedir();

export function claudeProjectsDir(env: Env = process.env): string {
  return join(env.CLAUDE_CONFIG_DIR || join(homeOf(env), ".claude"), "projects");
}

/** Claude Code's user settings, where `init` installs hooks. */
export function claudeSettingsPath(env: Env = process.env): string {
  return join(env.CLAUDE_CONFIG_DIR || join(homeOf(env), ".claude"), "settings.json");
}

export function codexSessionsDir(env: Env = process.env): string {
  return join(env.CODEX_HOME || join(homeOf(env), ".codex"), "sessions");
}

/** Cursor's `User` folder: Electron's per-OS application-data location. */
export function cursorUserDir(env: Env = process.env, platform: NodeJS.Platform = process.platform): string {
  const home = homeOf(env);
  if (platform === "darwin") return join(home, "Library", "Application Support", "Cursor", "User");
  if (platform === "win32") return join(env.APPDATA || join(home, "AppData", "Roaming"), "Cursor", "User");
  return join(env.XDG_CONFIG_HOME || join(home, ".config"), "Cursor", "User");
}

export function cursorDirs(env: Env = process.env, platform: NodeJS.Platform = process.platform): { globalDb: string; workspaceRoot: string } {
  const user = cursorUserDir(env, platform);
  return { globalDb: join(user, "globalStorage", "state.vscdb"), workspaceRoot: join(user, "workspaceStorage") };
}

export function opencodeDbPath(env: Env = process.env): string {
  if (env.GATEWAY_OPENCODE_DB) return env.GATEWAY_OPENCODE_DB;
  return join(env.XDG_DATA_HOME || join(homeOf(env), ".local", "share"), "opencode", "opencode.db");
}

/** The gateway's own store for agent trajectories (written by other agents, not a harness). */
export function trajectoryDir(env: Env = process.env): string {
  if (env.GATEWAY_TRAJECTORY_DIR) return env.GATEWAY_TRAJECTORY_DIR;
  return join(env.CONTEXT_GATEWAY_STATE || join(env.HOME ?? "/tmp", ".context-gateway"), "trajectories");
}

export interface HistorySource {
  kind: Extract<Harness, "claude-code" | "codex" | "cursor" | "opencode" | "trajectory">;
  path: string;
  /** Something is there to index (an empty trajectory folder does not count). */
  present: boolean;
  /** Where the location came from, when a variable moved it. */
  via?: string;
}

const nonEmptyDir = (p: string) => {
  try {
    return readdirSync(p).length > 0;
  } catch {
    return false;
  }
};

/** Every local history the adapters can read, and whether it exists here. */
export function detectHistories(env: Env = process.env, platform: NodeJS.Platform = process.platform): HistorySource[] {
  const src = (kind: HistorySource["kind"], path: string, present: boolean, via?: string): HistorySource =>
    via ? { kind, path, present, via } : { kind, path, present };
  const claude = claudeProjectsDir(env);
  const codex = codexSessionsDir(env);
  const cursor = cursorDirs(env, platform).globalDb;
  const opencode = opencodeDbPath(env);
  const traj = trajectoryDir(env);
  return [
    src("claude-code", claude, existsSync(claude), env.CLAUDE_CONFIG_DIR ? "CLAUDE_CONFIG_DIR" : undefined),
    src("codex", codex, existsSync(codex), env.CODEX_HOME ? "CODEX_HOME" : undefined),
    src("opencode", opencode, existsSync(opencode), env.GATEWAY_OPENCODE_DB ? "GATEWAY_OPENCODE_DB" : env.XDG_DATA_HOME ? "XDG_DATA_HOME" : undefined),
    src("cursor", cursor, existsSync(cursor), platform === "win32" && env.APPDATA ? "APPDATA" : platform !== "darwin" && platform !== "win32" && env.XDG_CONFIG_HOME ? "XDG_CONFIG_HOME" : undefined),
    src("trajectory", traj, nonEmptyDir(traj), env.GATEWAY_TRAJECTORY_DIR ? "GATEWAY_TRAJECTORY_DIR" : undefined),
  ];
}

/**
 * What the watcher follows: directories plus a test for the file names that
 * mean "new history". SQLite stores change through their -wal/-journal files
 * as often as through the database itself.
 */
export interface WatchTarget {
  harness: HistorySource["kind"];
  dir: string;
  recursive: boolean;
  matches: (filename: string) => boolean;
}

const jsonl = (f: string) => f.endsWith(".jsonl");
const trajectoryFile = (f: string) => f.endsWith(".jsonl") || f.endsWith(".json");
const sqliteFile = (base: string) => (f: string) => {
  const name = f.split(/[\\/]/).pop() ?? f;
  return name === base || name.startsWith(`${base}-`);
};

export function watchTargets(env: Env = process.env, platform: NodeJS.Platform = process.platform): WatchTarget[] {
  const opencode = opencodeDbPath(env);
  const cursor = cursorDirs(env, platform).globalDb;
  const base = (p: string) => p.split(/[\\/]/).pop() ?? p;
  const dirOf = (p: string) => join(p, "..");
  return [
    { harness: "claude-code", dir: claudeProjectsDir(env), recursive: true, matches: jsonl },
    { harness: "codex", dir: codexSessionsDir(env), recursive: true, matches: jsonl },
    { harness: "opencode", dir: dirOf(opencode), recursive: false, matches: sqliteFile(base(opencode)) },
    { harness: "cursor", dir: dirOf(cursor), recursive: false, matches: sqliteFile(base(cursor)) },
    { harness: "trajectory", dir: trajectoryDir(env), recursive: true, matches: trajectoryFile },
  ];
}
