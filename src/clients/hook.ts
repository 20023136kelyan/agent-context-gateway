/**
 * `bifrost hook <client> <event>`: the command agent clients run on each tool call
 * and at session start. Reads the client's JSON on stdin, asks the daemon, prints
 * the client's output format, and always exits 0 with nothing printed on failure.
 *
 *   claude-code  pre-tool (PreToolUse, before the call)   session-start (SessionStart)
 *   codex        post-tool (PostToolUse, after the call)  session-start (SessionStart)
 *   cursor       post-tool (postToolUse, after the call)  session-start (sessionStart)
 *
 * Formats: Claude Code and Codex read hookSpecificOutput.additionalContext; Cursor
 * reads additional_context (see docs/study/bifrost-on-maps.md §7.1).
 */
import { deliver } from "../daemon/client.js";

export type HookRequest = { path: "/tool"; body: { cwd: string; session: string; client: string; tool: string; input: unknown } } | { path: "/session"; body: { cwd: string; session: string; client: string } };

type Json = Record<string, unknown>;
const s = (v: unknown): string => (typeof v === "string" ? v : "");
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});

const CURSOR_TOOLS: Record<string, string> = { Shell: "Bash", Read: "Read", Write: "Write", Edit: "Edit", Grep: "Grep", Delete: "Write" };

/** Translates a client's hook payload into a daemon request; null when there is nothing to ask. */
export function toRequest(client: string, event: string, payload: Json): HookRequest | null {
  const cwd = s(payload.cwd) || s((payload.workspace_roots as unknown[] | undefined)?.[0]) || s(process.env.CLAUDE_PROJECT_DIR) || process.cwd();
  const session = s(payload.session_id) || s(payload.conversation_id) || "unknown";
  if (event === "session-start") return { path: "/session", body: { cwd, session, client } };
  if (event !== "pre-tool" && event !== "post-tool") return null;
  let tool = s(payload.tool_name);
  let input: unknown = payload.tool_input ?? {};
  if (!tool) return null;
  if (client === "codex" && tool === "apply_patch") input = { patch: s(obj(input).command) };
  if (client === "cursor") tool = CURSOR_TOOLS[tool] ?? tool;
  return { path: "/tool", body: { cwd, session, client, tool, input } };
}

const EVENT_NAMES: Record<string, Record<string, string>> = {
  "claude-code": { "pre-tool": "PreToolUse", "session-start": "SessionStart" },
  codex: { "post-tool": "PostToolUse", "session-start": "SessionStart" },
};

/** The client's stdout for a piece of context; "" when there is nothing to add. */
export function toOutput(client: string, event: string, text: string): string {
  if (!text) return "";
  if (client === "cursor") return JSON.stringify({ additional_context: text });
  const name = EVENT_NAMES[client]?.[event];
  if (!name) return "";
  return JSON.stringify({ hookSpecificOutput: { hookEventName: name, additionalContext: text } });
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export async function runHook(client: string, event: string, cliPath: string): Promise<void> {
  try {
    const payload = obj(JSON.parse((await readStdin()) || "{}"));
    const req = toRequest(client, event, payload);
    if (!req) return;
    const { text } = await deliver(req.path, req.body, cliPath);
    const out = toOutput(client, event, text);
    if (out) process.stdout.write(`${out}\n`);
  } catch {
    /* never block the agent */
  } finally {
    process.exitCode = 0;
  }
}
