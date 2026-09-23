/**
 * Where each harness keeps its history on this machine: the one answer shared
 * by the adapters (what sync reads), `init`/`doctor`/`paths` (what they
 * report) and the watcher (what it follows). Before this existed, init and
 * the watcher kept their own copies and knew only Claude Code and Codex, so an
 * OpenCode- or Cursor-only user was told "no agent histories found".
 *
 * A harness can have several locations (two Claude profiles, a copied
 * archive). For each harness, the first of these that applies wins:
 *
 *   1. the gateway's own variable: GATEWAY_OPENCODE_DB, GATEWAY_TRAJECTORY_DIR
 *      (environment beats settings.json everywhere in the gateway)
 *   2. locations saved with `acg paths` (settings.json `historyPaths`)
 *   3. the harness's own relocation variable, honoured the way the harness
 *      does: CLAUDE_CONFIG_DIR, CODEX_HOME, XDG_DATA_HOME (OpenCode), and the
 *      per-OS application-data folder for Cursor (an Electron app)
 *   4. the harness's standard location
 *
 * What a location names, per harness (normalizeHistoryPath accepts the
 * parent folder too): Claude Code its `projects` folder, Codex its
 * `sessions` folder, OpenCode its `opencode.db`, Cursor its `User` folder,
 * trajectories their folder.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { Harness } from "../core/models.js";

type Env = NodeJS.ProcessEnv;

export const HISTORY_KINDS = ["claude-code", "codex", "opencode", "cursor", "trajectory"] as const;
export type HistoryKind = Extract<Harness, (typeof HISTORY_KINDS)[number]>;
export const isHistoryKind = (k: string): k is HistoryKind => (HISTORY_KINDS as readonly string[]).includes(k);

/** How a location was chosen: "acg paths", a variable's name, or "default". */
export type HistoryVia = string;

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

/** The two stores inside a Cursor `User` folder. */
export function cursorStores(userDir: string): { globalDb: string; workspaceRoot: string } {
  return { globalDb: join(userDir, "globalStorage", "state.vscdb"), workspaceRoot: join(userDir, "workspaceStorage") };
}

export function cursorDirs(env: Env = process.env, platform: NodeJS.Platform = process.platform): { globalDb: string; workspaceRoot: string } {
  return cursorStores(cursorUserDir(env, platform));
}

export function opencodeDbPath(env: Env = process.env): string {
  if (env.GATEWAY_OPENCODE_DB) return env.GATEWAY_OPENCODE_DB;
  return join(env.XDG_DATA_HOME || join(homeOf(env), ".local", "share"), "opencode", "opencode.db");
}

const stateDirOf = (env: Env) => env.CONTEXT_GATEWAY_STATE || join(env.HOME ?? "/tmp", ".context-gateway");

/** The gateway's own store for agent trajectories (written by other agents, not a harness). */
export function trajectoryDir(env: Env = process.env): string {
  if (env.GATEWAY_TRAJECTORY_DIR) return env.GATEWAY_TRAJECTORY_DIR;
  return join(stateDirOf(env), "trajectories");
}

/**
 * Locations saved with `acg paths`. Read here rather than through settings.ts
 * so the adapters do not import the whole settings module (and its cycles).
 * A missing or malformed file means nothing is saved.
 */
export function savedHistoryPaths(env: Env = process.env): Partial<Record<HistoryKind, string[]>> {
  try {
    const raw = JSON.parse(readFileSync(join(stateDirOf(env), "settings.json"), "utf8")) as { historyPaths?: unknown };
    const hp = raw?.historyPaths;
    if (!hp || typeof hp !== "object") return {};
    const out: Partial<Record<HistoryKind, string[]>> = {};
    for (const [k, v] of Object.entries(hp as Record<string, unknown>)) {
      if (!isHistoryKind(k) || !Array.isArray(v)) continue;
      const list = v.filter((x): x is string => typeof x === "string" && x.length > 0);
      if (list.length) out[k] = list;
    }
    return out;
  } catch {
    return {};
  }
}

export interface HistoryRoot {
  kind: HistoryKind;
  path: string;
  via: HistoryVia;
}

/** Every location the adapters read, in the precedence order described above. */
export function historyRoots(env: Env = process.env, platform: NodeJS.Platform = process.platform): HistoryRoot[] {
  const saved = savedHistoryPaths(env);
  const out: HistoryRoot[] = [];
  const add = (kind: HistoryKind, own: [string, string] | null, fallback: [string, HistoryVia]) => {
    if (own) out.push({ kind, path: own[1], via: own[0] });
    else if (saved[kind]?.length) for (const path of saved[kind]!) out.push({ kind, path, via: "acg paths" });
    else out.push({ kind, path: fallback[0], via: fallback[1] });
  };
  add("claude-code", null, [claudeProjectsDir(env), env.CLAUDE_CONFIG_DIR ? "CLAUDE_CONFIG_DIR" : "default"]);
  add("codex", null, [codexSessionsDir(env), env.CODEX_HOME ? "CODEX_HOME" : "default"]);
  add(
    "opencode",
    env.GATEWAY_OPENCODE_DB ? ["GATEWAY_OPENCODE_DB", env.GATEWAY_OPENCODE_DB] : null,
    [opencodeDbPath(env), env.XDG_DATA_HOME ? "XDG_DATA_HOME" : "default"],
  );
  const cursorVar = platform === "win32" ? (env.APPDATA ? "APPDATA" : null) : platform !== "darwin" && env.XDG_CONFIG_HOME ? "XDG_CONFIG_HOME" : null;
  add("cursor", null, [cursorUserDir(env, platform), cursorVar ?? "default"]);
  add(
    "trajectory",
    env.GATEWAY_TRAJECTORY_DIR ? ["GATEWAY_TRAJECTORY_DIR", env.GATEWAY_TRAJECTORY_DIR] : null,
    [trajectoryDir(env), "default"],
  );
  return out;
}

/** Locations chosen with `acg paths` for one harness, or null when it uses its default. */
export function savedRoots(kind: HistoryKind, env: Env = process.env): string[] | null {
  const roots = historyRoots(env).filter((r) => r.kind === kind && r.via === "acg paths");
  return roots.length ? roots.map((r) => r.path) : null;
}

const nonEmptyDir = (p: string) => {
  try {
    return readdirSync(p).length > 0;
  } catch {
    return false;
  }
};

/** Whether a location holds something that harness's adapter could read. */
export function rootPresent(kind: HistoryKind, path: string): boolean {
  if (kind === "cursor") return existsSync(cursorStores(path).globalDb);
  if (kind === "trajectory") return nonEmptyDir(path);
  return existsSync(path);
}

export interface HistorySource {
  kind: HistoryKind;
  path: string;
  /** Something is there to index (an empty trajectory folder does not count). */
  present: boolean;
  via: HistoryVia;
}

/** Every local history location the adapters read, and whether it exists here. */
export function detectHistories(env: Env = process.env, platform: NodeJS.Platform = process.platform): HistorySource[] {
  return historyRoots(env, platform).map((r) => ({ kind: r.kind, path: r.path, present: rootPresent(r.kind, r.path), via: r.via }));
}

const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/**
 * Turn what someone typed into the location this harness's adapter reads,
 * accepting the obvious parent too: `~/.claude` for `~/.claude/projects`,
 * a Codex home for its `sessions`, the folder holding `opencode.db`, Cursor's
 * `state.vscdb` or its application folder for `User`.
 */
export function normalizeHistoryPath(kind: HistoryKind, input: string, env: Env = process.env): string {
  const home = homeOf(env);
  const p = resolve(input === "~" ? home : input.startsWith("~/") ? join(home, input.slice(2)) : input);
  const into = (child: string) => (basename(p) !== child && isDir(join(p, child)) ? join(p, child) : p);
  switch (kind) {
    case "claude-code":
      return into("projects");
    case "codex":
      return into("sessions");
    case "opencode":
      return isDir(p) && existsSync(join(p, "opencode.db")) ? join(p, "opencode.db") : p;
    case "cursor":
      if (basename(p) === "state.vscdb") return dirname(dirname(p));
      if (basename(p) === "globalStorage") return dirname(p);
      return basename(p) !== "User" && isDir(join(p, "User")) ? join(p, "User") : p;
    case "trajectory":
      return p;
  }
}

/**
 * What the watcher follows: directories plus a test for the file names that
 * mean "new history". SQLite stores change through their -wal/-journal files
 * as often as through the database itself.
 */
export interface WatchTarget {
  harness: HistoryKind;
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
  return historyRoots(env, platform).map(({ kind, path }): WatchTarget => {
    switch (kind) {
      case "opencode":
        return { harness: kind, dir: dirname(path), recursive: false, matches: sqliteFile(basename(path)) };
      case "cursor": {
        const db = cursorStores(path).globalDb;
        return { harness: kind, dir: dirname(db), recursive: false, matches: sqliteFile(basename(db)) };
      }
      case "trajectory":
        return { harness: kind, dir: path, recursive: true, matches: trajectoryFile };
      default:
        return { harness: kind, dir: path, recursive: true, matches: jsonl };
    }
  });
}
