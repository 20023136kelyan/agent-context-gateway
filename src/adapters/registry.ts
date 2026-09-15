/** Adapter registry — MVP: Claude Code + Codex, local-only. */
import type { ContextAdapter } from "./types.js";
import { ClaudeAdapter } from "./claude.js";
import { CodexAdapter } from "./codex.js";
import { CursorAdapter } from "./cursor.js";
import { ZepAdapter } from "./zep.js";

export function createAdapters(opts?: {
  claudeDir?: string;
  codexDir?: string;
  cursorDb?: string;
  zepDir?: string;
}): ContextAdapter[] {
  return [
    ...(opts?.claudeDir ? [new ClaudeAdapter(opts.claudeDir)] : [new ClaudeAdapter()]),
    ...(opts?.codexDir ? [new CodexAdapter(opts.codexDir)] : [new CodexAdapter()]),
    ...(opts?.cursorDb ? [new CursorAdapter(opts.cursorDb)] : [new CursorAdapter()]),
    ...(opts?.zepDir ? [new ZepAdapter({ localDir: opts.zepDir })] : [new ZepAdapter()]),
  ];
}

export async function listAllSessions(adapters: ContextAdapter[]) {
  const out = [];
  for (const a of adapters) {
    try {
      out.push(...(await a.listSessions()));
    } catch {
      // source unavailable — caller surfaces via health, never fabricates
    }
  }
  return out;
}
