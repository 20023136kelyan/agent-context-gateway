/**
 * Where Bifröst keeps its files. No imports beyond Node's path and os modules, so
 * hooks can use it without loading the store.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const DEFAULT_PORT = 47120;

export function defaultStorePath(): string {
  if (process.env.BIFROST_DB) return process.env.BIFROST_DB;
  const dataHome = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  return join(dataHome, "bifrost", "bifrost.db");
}

export interface DaemonInfo {
  pid: number;
  port: number;
  version: string;
  store: string;
  startedAt: string;
}

export function daemonInfoPath(): string {
  if (process.env.BIFROST_DAEMON_FILE) return process.env.BIFROST_DAEMON_FILE;
  return join(dirname(defaultStorePath()), "daemon.json");
}

export function readDaemonInfo(path = daemonInfoPath()): DaemonInfo | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as DaemonInfo;
  } catch {
    return null;
  }
}
