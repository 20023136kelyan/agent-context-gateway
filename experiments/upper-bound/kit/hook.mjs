#!/usr/bin/env node
/**
 * Bifröst experiment hook: PreToolUse for Claude Code (and BeforeTool-style callers).
 *
 * Reads the tool call as JSON on stdin. When the call touches a place with notes,
 * prints { hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext } }.
 * Otherwise prints nothing. Always exits 0 and never blocks the tool call.
 *
 * Environment:
 *   BIFROST_NOTES        path to the notes JSON (unset: behave as noop)
 *   BIFROST_MODE         "inject" (default) or "noop" (log only; the control arm)
 *   BIFROST_LOG          JSONL file that records every call and what was shown
 *   BIFROST_STATE        directory for per-session state (what was already shown)
 *   BIFROST_MAX_NOTES    default 3
 *   BIFROST_BUDGET_CHARS default 900
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { EDIT_TOOLS, REPEAT_ON_EDIT, formatNotes, loadNotes, matchNotes, placesFromToolCall } from "./notes-lib.mjs";

function readStdin() {
  try { return readFileSync(0, "utf8"); } catch { return ""; }
}

function loadState(dir, session) {
  if (!dir) return { shown: [], shownOnEdit: [] };
  try { return JSON.parse(readFileSync(join(dir, `${safe(session)}.json`), "utf8")); } catch { return { shown: [], shownOnEdit: [] }; }
}

function saveState(dir, session, state) {
  if (!dir) return;
  try { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, `${safe(session)}.json`), JSON.stringify(state)); } catch { /* fail open */ }
}

const safe = (s) => String(s || "no-session").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80);

function log(entry) {
  const file = process.env.BIFROST_LOG;
  if (!file) return;
  try { appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), channel: "push", ...entry }) + "\n"); } catch { /* fail open */ }
}

export function decide(event, env = process.env) {
  const mode = env.BIFROST_MODE === "noop" || !env.BIFROST_NOTES ? "noop" : "inject";
  const root = env.CLAUDE_PROJECT_DIR || event.cwd || process.cwd();
  const tool = event.tool_name ?? event.toolName ?? "";
  const input = event.tool_input ?? event.toolInput ?? event.input ?? {};
  const session = event.session_id ?? event.sessionId ?? "";
  const notes = env.BIFROST_NOTES ? loadNotes(env.BIFROST_NOTES) : [];
  const knownPaths = [...new Set(notes.map((n) => n.anchor.path))];
  const places = placesFromToolCall(tool, input, root, knownPaths);
  const matched = matchNotes(notes, places);

  const state = loadState(env.BIFROST_STATE, session);
  const isEdit = EDIT_TOOLS.has(tool);
  const fresh = matched.filter((n) => !state.shown.includes(n.id) || (isEdit && REPEAT_ON_EDIT.has(n.type) && !state.shownOnEdit.includes(n.id)));

  const base = { session, tool, places: places.map((p) => p.path), matched: matched.map((n) => n.id), mode };
  if (mode === "noop" || fresh.length === 0) return { output: "", logEntry: { ...base, shown: [] }, state: null };

  const { text, shown } = formatNotes(fresh, {
    maxNotes: Number(env.BIFROST_MAX_NOTES ?? 3) || 3,
    budgetChars: Number(env.BIFROST_BUDGET_CHARS ?? 900) || 900,
  });
  if (!text) return { output: "", logEntry: { ...base, shown: [] }, state: null };
  const next = {
    shown: [...new Set([...state.shown, ...shown])],
    shownOnEdit: isEdit ? [...new Set([...state.shownOnEdit, ...shown])] : state.shownOnEdit,
  };
  const output = JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: text } });
  return { output, logEntry: { ...base, shown, chars: text.length }, state: next };
}

function main() {
  let event;
  try { event = JSON.parse(readStdin() || "{}"); } catch { return; }
  if (!event || typeof event !== "object") return;
  try {
    const { output, logEntry, state } = decide(event);
    if (state) saveState(process.env.BIFROST_STATE, logEntry.session, state);
    log(logEntry);
    if (output) process.stdout.write(output + "\n");
  } catch (err) {
    log({ error: String(err?.message ?? err) });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
  process.exitCode = 0;
}
