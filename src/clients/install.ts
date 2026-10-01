/**
 * `bifrost install <client>`: registers Bifröst in a client's own configuration.
 * Merges into existing files, replaces only Bifröst's own entries (so running it
 * twice changes nothing), and refuses to touch a file it cannot parse.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { SESSION_EXPLANATION } from "../delivery/format.js";
import { defaultStorePath } from "../paths.js";

export const CLIENTS = ["opencode", "claude-code", "codex", "cursor"] as const;
export type Client = (typeof CLIENTS)[number];

export interface InstallOptions {
  cliPath: string;
  scope: "user" | "project";
  cwd: string;
  home?: string;
  nodePath?: string;
}

type Json = Record<string, unknown>;

/** Bifröst's own hook entries, from this or an earlier install. */
const isOurs = (command: unknown) => typeof command === "string" && command.includes("bifrost") && (command.includes("hook-main.js") || command.includes(" hook "));

function readJson(path: string): Json {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf8");
  if (!raw.trim()) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Json;
  } catch {
    /* fall through */
  }
  throw new Error(`${path} is not plain JSON (comments or a syntax error?); not changing it. Add the entries by hand.`);
}

function writeJson(path: string, value: Json): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function hookCommand(o: InstallOptions, client: Client, event: string): string {
  if (!o.cliPath.endsWith(".js")) throw new Error("install needs the built CLI: run `npm run build`, then `node dist/cli.js install …`");
  return `"${o.nodePath ?? process.execPath}" "${join(dirname(o.cliPath), "hook-main.js")}" ${client} ${event}`;
}

/** Claude Code and Codex share this shape: { hooks: { Event: [{ matcher?, hooks: [{ type, command }] }] } }. */
function setGroupedHook(config: Json, event: string, command: string, matcher?: string, extra: Json = {}): void {
  const hooks = (config.hooks ??= {}) as Json;
  const groups = ((hooks[event] as Json[] | undefined) ?? []).filter((g) => !((g.hooks as Json[] | undefined) ?? []).some((h) => isOurs(h.command)));
  groups.push({ ...(matcher ? { matcher } : {}), hooks: [{ type: "command", command, ...extra }] });
  hooks[event] = groups;
}

export function install(client: string, o: InstallOptions): string[] {
  const home = o.home ?? homedir();
  switch (client as Client) {
    case "claude-code": {
      const file = o.scope === "project" ? join(o.cwd, ".claude", "settings.json") : join(home, ".claude", "settings.json");
      const config = readJson(file);
      setGroupedHook(config, "PreToolUse", hookCommand(o, "claude-code", "pre-tool"), "Read|Edit|Write|MultiEdit|NotebookEdit|Grep|Glob|Bash", { timeout: 5 });
      setGroupedHook(config, "SessionStart", hookCommand(o, "claude-code", "session-start"), undefined, { timeout: 5 });
      writeJson(file, config);
      return [`Claude Code: hooks added to ${file} (PreToolUse, SessionStart).`];
    }
    case "codex": {
      const file = o.scope === "project" ? join(o.cwd, ".codex", "hooks.json") : join(home, ".codex", "hooks.json");
      const config = readJson(file);
      setGroupedHook(config, "PostToolUse", hookCommand(o, "codex", "post-tool"), undefined, { timeout: 5 });
      setGroupedHook(config, "SessionStart", hookCommand(o, "codex", "session-start"), undefined, { timeout: 5 });
      writeJson(file, config);
      return [`Codex: hooks added to ${file} (PostToolUse, SessionStart). Notes arrive after each tool call.`];
    }
    case "cursor": {
      const file = o.scope === "project" ? join(o.cwd, ".cursor", "hooks.json") : join(home, ".cursor", "hooks.json");
      const config = readJson(file);
      config.version ??= 1;
      const hooks = (config.hooks ??= {}) as Json;
      for (const [event, name] of [["post-tool", "postToolUse"], ["session-start", "sessionStart"]] as const) {
        const list = ((hooks[name] as Json[] | undefined) ?? []).filter((h) => !isOurs(h.command));
        list.push({ command: hookCommand(o, "cursor", event) });
        hooks[name] = list;
      }
      writeJson(file, config);
      return [`Cursor: hooks added to ${file} (postToolUse, sessionStart). Notes arrive after each tool call.`];
    }
    case "opencode": {
      if (!o.cliPath.endsWith(".js")) throw new Error("install needs the built CLI: run `npm run build`, then `node dist/cli.js install …`");
      const file = o.scope === "project" ? join(o.cwd, "opencode.json") : join(home, ".config", "opencode", "opencode.json");
      const config = readJson(file);
      const plugin = pathToFileURL(join(dirname(o.cliPath), "clients", "opencode-plugin.js")).href;
      const explanation = join(dirname(defaultStorePath()), "session.md");
      mkdirSync(dirname(explanation), { recursive: true });
      writeFileSync(explanation, `${SESSION_EXPLANATION}\n`);
      const plugins = ((config.plugin as string[] | undefined) ?? []).filter((p) => !(typeof p === "string" && p.includes("opencode-plugin.js") && p.includes("bifrost")));
      config.plugin = [...plugins, plugin];
      const instructions = ((config.instructions as string[] | undefined) ?? []).filter((p) => p !== explanation);
      config.instructions = [...instructions, explanation];
      config.$schema ??= "https://opencode.ai/config.json";
      writeJson(file, config);
      return [`OpenCode: plugin and instructions added to ${file}. Notes arrive after each tool call.`];
    }
    default:
      throw new Error(`unknown client "${client}"; choose one of: ${CLIENTS.join(", ")}`);
  }
}
