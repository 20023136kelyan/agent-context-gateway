/**
 * Agents under test, behind one interface. Each run gets the task prompt in a
 * fresh workspace and, in gateway arms, the gateway's MCP server; the adapter
 * turns the agent's own event stream into one timeline: model steps (with
 * tokens and time) and tool calls (with what they touched), so every agent is
 * measured the same way.
 */
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanEnv, ensureDir, run } from "./util.js";

export interface Tokens {
  input: number;
  output: number;
  thinking: number;
  cacheRead: number;
}

export interface AgentEvent {
  /** ms since the agent started */
  t: number;
  kind: "llm" | "tool" | "text";
  durMs?: number;
  tokens?: Tokens;
  name?: string;
  params?: Record<string, unknown>;
  /** Tool output, cut to a few KB. */
  output?: string;
  /** A call to the gateway's MCP server. */
  gateway?: boolean;
  /** A tool call that writes a file. */
  edit?: boolean;
  text?: string;
}

export interface AgentRunResult {
  exitCode: number | null;
  timedOut: boolean;
  wallMs: number;
  /** The agent's own verdict on its turn (agy: SUCCESS / ERROR; Claude Code: success / error_*). */
  status: string;
  finalText: string;
  /** Tools the agent was offered: in a gateway arm, the gateway's must be among them. */
  toolsAvailable: string[];
  /** What the agent reports the run cost, if it does. */
  costUsd?: number;
  /** Set when the model's API cut the run short (a usage limit, an outage): the run says nothing about the task. */
  apiError?: string;
  conversationId?: string;
  stderr: string;
}

export interface AgentAdapter {
  name: string;
  defaultModel: string;
  /**
   * Put the agent's per-run configuration in place: the gateway (when the
   * arm has one) and the hint rule (when it has one), where this agent reads
   * them. `workDir` holds the clone (`ws`) and is the only other folder the
   * sandbox lets the agent use.
   */
  prepare(o: { ws: string; workDir: string; gatewayUrl: string | null; hint: string | null }): void;
  run(o: {
    ws: string;
    workDir: string;
    prompt: string;
    model: string;
    /** Command prefix the agent runs under (the sandbox). */
    wrap: string[];
    /** In a gateway arm, the gateway's URL: a call that reaches it by any tool counts as a gateway call. */
    gatewayUrl: string | null;
    timeoutMs: number;
    rawPath: string;
    onEvent: (e: AgentEvent) => void;
  }): Promise<AgentRunResult>;
  /** Is this tool name one of the gateway's? */
  isGatewayTool(name: string): boolean;
}

const EDIT_TOOL = /(write|replace|edit|create|patch|insert).*(file|content)|^apply_patch$|^(edit|write|multiedit|notebookedit)$/i;
const cut = (s: unknown, n = 4000) => {
  const t = typeof s === "string" ? s : JSON.stringify(s ?? "");
  return t.length > n ? `${t.slice(0, n)}… [${t.length - n} more chars]` : t;
};
const excludeFromDiff = (ws: string, ...paths: string[]) => appendFileSync(join(ws, ".git", "info", "exclude"), paths.map((p) => `${p}\n`).join(""));
const wrapped = (wrap: string[], cmd: string, args: string[]): [string, string[]] => (wrap.length ? [wrap[0]!, [...wrap.slice(1), cmd, ...args]] : [cmd, args]);

/**
 * Antigravity CLI (Gemini). Print mode with --dangerously-skip-permissions,
 * stream-json events. Its workspace is what --add-dir names (its shell tool
 * does not start in the process's cwd). MCP servers come from a plugin inside
 * the workspace (.agents/plugins/<name>/mcp_config.json), so each run has its
 * own and a run without the gateway has none; the user's global agy config is
 * not touched. agy offers MCP tools through one tool, call_mcp_tool, with each
 * tool's schema in a file it reads first.
 */
export const agy: AgentAdapter = {
  name: "agy",
  defaultModel: "gemini-3.8-flash-high",
  isGatewayTool: (name) => name === "call_mcp_tool" || /(^|[_.])context[._]/.test(name),
  prepare({ ws, gatewayUrl, hint }) {
    if (gatewayUrl) {
      const plugin = ensureDir(join(ws, ".agents", "plugins", "acg"));
      writeFileSync(join(plugin, "plugin.json"), JSON.stringify({ name: "acg", description: "Search earlier agent sessions on this project" }, null, 2));
      writeFileSync(join(plugin, "mcp_config.json"), JSON.stringify({ mcpServers: { gateway: { serverUrl: gatewayUrl } } }, null, 2));
    }
    if (hint) writeFileSync(join(ensureDir(join(ws, ".agents", "rules")), "earlier-sessions.md"), hint);
  },
  async run(o) {
    const t0 = Date.now();
    let status = "UNKNOWN";
    let finalText = "";
    let toolsAvailable: string[] = [];
    let conversationId: string | undefined;
    const args = ["--output-format", "stream-json", "--model", o.model, "--dangerously-skip-permissions", "--disable-slash-commands", "--add-dir", o.ws, "-p", o.prompt];
    const [cmd, argv] = wrapped(o.wrap, "agy", args);
    const r = await run(cmd, argv, {
      cwd: o.ws,
      env: cleanEnv(),
      timeoutMs: o.timeoutMs,
      onStdoutLine: (line) => {
        if (!line.trim()) return;
        appendFileSync(o.rawPath, line + "\n");
        let e: Record<string, unknown>;
        try {
          e = JSON.parse(line);
        } catch {
          return;
        }
        const t = Date.now() - t0;
        if (e.event === "init") {
          conversationId = e.conversation_id as string;
          toolsAvailable = ((e.init as { tools?: string[] })?.tools ?? []).map(String);
          return;
        }
        if (e.event === "result") {
          const res = e.result as { status?: string; response?: string; conversation_id?: string };
          status = res.status ?? status;
          finalText = res.response ?? "";
          conversationId ??= res.conversation_id;
          o.onEvent({ t, kind: "text", text: cut(finalText, 8000) });
          return;
        }
        const s = e.step_update as {
          state?: string;
          step_type?: string;
          duration_seconds?: number;
          usage?: { input_tokens?: number; output_tokens?: number; thinking_tokens?: number; cache_read_tokens?: number };
          tool_name?: string;
          tool_info?: { name?: string; parameters?: Record<string, unknown>; output?: unknown };
        };
        if (!s || s.state !== "DONE") return;
        const durMs = Math.round((s.duration_seconds ?? 0) * 1000);
        if (s.step_type === "agent_response") {
          const u = s.usage ?? {};
          o.onEvent({
            t,
            kind: "llm",
            durMs,
            tokens: { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, thinking: u.thinking_tokens ?? 0, cacheRead: u.cache_read_tokens ?? 0 },
          });
        } else if (s.step_type === "tool") {
          const name = s.tool_name ?? s.tool_info?.name ?? "tool";
          const reachesGateway = Boolean(o.gatewayUrl && JSON.stringify(s.tool_info?.parameters ?? {}).includes(new URL(o.gatewayUrl).host));
          o.onEvent({
            t,
            kind: "tool",
            durMs,
            name,
            params: s.tool_info?.parameters,
            output: s.tool_info?.output === undefined ? undefined : cut(s.tool_info.output),
            gateway: agy.isGatewayTool(name) || reachesGateway,
            edit: EDIT_TOOL.test(name),
          });
        }
      },
    });
    return { exitCode: r.code, timedOut: r.timedOut, wallMs: Date.now() - t0, status, finalText, toolsAvailable, conversationId, stderr: r.stderr.slice(-4000) };
  },
};

/**
 * Claude Code in print mode, stream-json. Isolated from the user's own setup:
 * --setting-sources project (no user settings, plugins or hooks),
 * --strict-mcp-config with this run's config only (an empty one without the
 * gateway), --no-session-persistence (no transcript lands in
 * ~/.claude/projects, which the gateway indexes), its temp files in the run's
 * folder (CLAUDE_CODE_TMPDIR), and the sandbox closing the user's CLAUDE.md,
 * skills, plugins, transcripts and file history. MCP tools are first-class:
 * the gateway's appear as mcp__acg__<tool>. The hint is a workspace CLAUDE.md.
 */
export const claude: AgentAdapter = {
  name: "claude",
  defaultModel: "claude-sonnet-5",
  isGatewayTool: (name) => name.startsWith("mcp__acg__"),
  prepare({ ws, workDir, gatewayUrl, hint }) {
    const servers = gatewayUrl ? { acg: { type: "http", url: gatewayUrl } } : {};
    writeFileSync(join(workDir, "mcp.json"), JSON.stringify({ mcpServers: servers }, null, 2));
    ensureDir(join(workDir, "tmp"));
    if (hint) {
      writeFileSync(join(ws, "CLAUDE.md"), hint);
      excludeFromDiff(ws, "CLAUDE.md");
    }
  },
  async run(o) {
    const t0 = Date.now();
    let status = "unknown";
    let finalText = "";
    let toolsAvailable: string[] = [];
    let costUsd: number | undefined;
    let apiError: string | undefined;
    let conversationId: string | undefined;
    let lastAt = 0;
    const seenMessages = new Set<string>();
    const pending = new Map<string, { t: number; name: string; params: Record<string, unknown> }>();
    const args = [
      "-p", "--output-format", "stream-json", "--verbose", "--model", o.model,
      "--no-session-persistence", "--setting-sources", "project",
      "--strict-mcp-config", "--mcp-config", join(o.workDir, "mcp.json"),
      "--dangerously-skip-permissions", o.prompt,
    ];
    const [cmd, argv] = wrapped(o.wrap, "claude", args);
    const r = await run(cmd, argv, {
      cwd: o.ws,
      env: cleanEnv({ CLAUDE_CODE_TMPDIR: join(o.workDir, "tmp"), DISABLE_AUTOUPDATER: "1" }),
      timeoutMs: o.timeoutMs,
      stdinNull: true,
      onStdoutLine: (line) => {
        if (!line.trim()) return;
        appendFileSync(o.rawPath, line + "\n");
        let e: Record<string, any>;
        try {
          e = JSON.parse(line);
        } catch {
          return;
        }
        const t = Date.now() - t0;
        if (e.type === "system" && e.subtype === "init") {
          conversationId = e.session_id;
          toolsAvailable = (e.tools ?? []).map(String);
          lastAt = t;
          return;
        }
        if (e.type === "assistant" && e.message) {
          const m = e.message as { id?: string; usage?: Record<string, any>; content?: any[] };
          // One API call can arrive as several events (one per content block) with the same id and usage.
          if (m.id && !seenMessages.has(m.id)) {
            seenMessages.add(m.id);
            const u = m.usage ?? {};
            o.onEvent({
              t,
              kind: "llm",
              durMs: Math.max(0, t - lastAt),
              tokens: {
                input: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
                output: u.output_tokens ?? 0,
                thinking: u.output_tokens_details?.thinking_tokens ?? 0,
                cacheRead: u.cache_read_input_tokens ?? 0,
              },
            });
          }
          for (const c of m.content ?? []) if (c?.type === "tool_use") pending.set(c.id, { t, name: c.name, params: c.input ?? {} });
          lastAt = t;
          return;
        }
        if (e.type === "user" && Array.isArray(e.message?.content)) {
          for (const c of e.message.content) {
            if (c?.type !== "tool_result") continue;
            const call = pending.get(c.tool_use_id);
            if (!call) continue;
            pending.delete(c.tool_use_id);
            const out = Array.isArray(c.content) ? c.content.map((x: any) => x?.text ?? "").join("\n") : c.content;
            o.onEvent({
              t,
              kind: "tool",
              durMs: t - call.t,
              name: call.name,
              params: call.params,
              output: cut(out),
              gateway: claude.isGatewayTool(call.name) || Boolean(o.gatewayUrl && JSON.stringify(call.params).includes(new URL(o.gatewayUrl).host)),
              edit: EDIT_TOOL.test(call.name),
            });
          }
          lastAt = t;
          return;
        }
        if (e.type === "result") {
          status = e.subtype ?? status;
          finalText = typeof e.result === "string" ? e.result : "";
          costUsd = typeof e.total_cost_usd === "number" ? e.total_cost_usd : undefined;
          if (e.is_error && (e.terminal_reason === "api_error" || e.api_error_status)) apiError = `${e.api_error_status ?? "api_error"}: ${finalText}`;
          o.onEvent({ t, kind: "text", text: cut(finalText, 8000) });
        }
      },
    });
    return { exitCode: r.code, timedOut: r.timedOut, wallMs: Date.now() - t0, status, finalText, toolsAvailable, costUsd, apiError, conversationId, stderr: r.stderr.slice(-4000) };
  },
};

export const AGENTS: Record<string, AgentAdapter> = { agy, claude };
