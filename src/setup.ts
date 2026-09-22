/**
 * Onboarding primitives behind `gateway init` (product surface).
 *
 * All filesystem mutations are explicit, backed up, and idempotent: running
 * init twice changes nothing the second time. Nothing here phones home;
 * keys are only ever appended to the local .env, never printed or sent.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

export interface HistorySource {
  kind: "claude-code" | "codex";
  path: string;
  present: boolean;
}

/** Native history locations (same roots the adapters read). */
export function detectHistories(env: NodeJS.ProcessEnv = process.env): HistorySource[] {
  const home = env.HOME ?? homedir();
  const claudeDir = join(home, ".claude", "projects");
  const codexDir = join(home, ".codex", "sessions");
  return [
    { kind: "claude-code", path: claudeDir, present: existsSync(claudeDir) },
    { kind: "codex", path: codexDir, present: existsSync(codexDir) },
  ];
}

export function keyStatus(env: NodeJS.ProcessEnv = process.env): Record<string, boolean> {
  return {
    VOYAGE_API_KEY: Boolean(env.VOYAGE_API_KEY),
    TYPESAFE_API_KEY: Boolean(env.TYPESAFE_API_KEY || env.JEV_API_KEY),
  };
}

/**
 * Append missing KEY=VALUE lines to a .env file. Existing keys are never
 * touched (no overwrite, no duplicate lines). Returns what was added.
 */
export function appendEnvKeys(envPath: string, entries: Record<string, string>): string[] {
  let current = "";
  try {
    current = readFileSync(envPath, "utf8");
  } catch {
    // missing file: create it below
  }
  const have = new Set(
    current
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"))
      .map((l) => l.split("=")[0]),
  );
  const added: string[] = [];
  const lines = current.length > 0 && !current.endsWith("\n") ? [current, ""] : [current];
  for (const [k, v] of Object.entries(entries)) {
    if (!v || have.has(k)) continue;
    lines.push(`${k}=${v}`);
    added.push(k);
  }
  if (added.length > 0) {
    mkdirSync(dirname(envPath), { recursive: true });
    writeFileSync(envPath, lines.join("\n"));
  }
  return added;
}

export interface HookInstall {
  installed: boolean;
  backupPath: string | null;
}

/**
 * Merge a SessionEnd hook into ~/.claude/settings.json without disturbing
 * anything already there. Idempotent: re-running finds its own marker and
 * stops. A timestamped backup precedes every write.
 */
export const HOOK_MARKER = "context-gateway-sync-session";

export function installClaudeHook(
  settingsPath = join(homedir(), ".claude", "settings.json"),
  cliPath: string,
): HookInstall {
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    if (typeof settings !== "object" || settings === null) settings = {};
  } catch {
    settings = {};
  }
  const hooks = (settings.hooks ?? {}) as Record<string, unknown>;
  const sessionEnd = (hooks.SessionEnd ?? []) as unknown[];
  const serialized = JSON.stringify(sessionEnd);
  if (serialized.includes(HOOK_MARKER)) return { installed: false, backupPath: null };

  const entry = {
    hooks: [
      {
        type: "command",
        command: `SID=$(jq -r .session_id); node --import tsx "${cliPath}" sync-session claude-code "$SID" # ${HOOK_MARKER}`,
      },
    ],
  };
  const next = {
    ...settings,
    hooks: { ...hooks, SessionEnd: [...sessionEnd, entry] },
  };
  if (existsSync(settingsPath)) {
    const backupPath = `${settingsPath}.pre-gateway-${Date.now()}`;
    copyFileSync(settingsPath, backupPath);
    writeFileSync(settingsPath, JSON.stringify(next, null, 2));
    return { installed: true, backupPath };
  }
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(next, null, 2));
  return { installed: true, backupPath: null };
}
