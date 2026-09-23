/**
 * The user's own configuration file: `<state dir>/.env` (~/.context-gateway).
 *
 * A checkout loads its repo `.env` through the npm scripts and gateway.sh. An
 * installed package has no repo: keys written by `init` live here instead,
 * readable only by the owner, and the CLI loads them itself. Values already
 * in the environment always win, so an exported variable overrides the file.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseEnv } from "node:util";
import { defaultStateDir } from "./settings.js";

export function userEnvPath(stateDir: string = defaultStateDir()): string {
  return join(stateDir, ".env");
}

/** Load `<state dir>/.env` without overriding anything already set. Returns the keys it set. */
export function loadUserEnv(path: string = userEnvPath()): string[] {
  if (!existsSync(path)) return [];
  let parsed: Record<string, string>;
  try {
    parsed = parseEnv(readFileSync(path, "utf8")) as Record<string, string>;
  } catch {
    return [];
  }
  const set: string[] = [];
  for (const [k, v] of Object.entries(parsed)) {
    if (process.env[k] === undefined) {
      process.env[k] = v;
      set.push(k);
    }
  }
  return set;
}

/** Create the directory for the user env file and keep the file owner-only. */
export function prepareUserEnv(path: string = userEnvPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) chmodSync(path, 0o600);
}
