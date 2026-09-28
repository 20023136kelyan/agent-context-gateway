#!/usr/bin/env node
/**
 * Scripted stand-in for a coding agent, for smoke-testing the harness without
 * spending on real agents. It "reads" src/authClient.js through the Bifröst hook
 * exactly as Claude Code would call it, prints Claude-style stream-json, and then
 * applies a reference fix:
 *   FAKE_SOLUTION=correct|naive|none  forces a fix
 *   otherwise: the correct fix if the hook showed it notes, else the naive retry
 *
 * usage (via run.ts): --agent command --agent-cmd "node <this> {workspace} {runDir}"
 */
import { spawnSync } from "node:child_process";
import { copyFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [ws] = process.argv.slice(2);
const here = dirname(fileURLToPath(import.meta.url));
const task = resolve(here, "..", "tasks", "refresh-rotation");
const session = `fake-${process.pid}`;
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\n");

emit({ type: "system", subtype: "init", session_id: session, cwd: ws });
const file = join(ws, "src/authClient.js");
emit({ type: "assistant", message: { content: [{ type: "text", text: "Looking at how refresh works." }, { type: "tool_use", id: "t1", name: "Read", input: { file_path: file } }] } });

const hook = spawnSync(process.execPath, [join(here, "..", "kit", "hook.mjs")], {
  input: JSON.stringify({ session_id: session, cwd: ws, hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: file } }),
  encoding: "utf8",
  env: process.env,
});
const sawNotes = hook.stdout.includes("additionalContext");
emit({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "…file contents…" }] } });

const choice = process.env.FAKE_SOLUTION ?? (sawNotes ? "correct" : "naive");
if (choice !== "none") copyFileSync(join(task, "reference", choice, "src/authClient.js"), file);
emit({ type: "assistant", message: { content: [{ type: "tool_use", id: "t2", name: "Edit", input: { file_path: file, old_string: "async refreshSession() {", new_string: "async refreshSession() { /* retry */" } }] } });
emit({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t2", content: "ok" }] } });
emit({ type: "assistant", message: { content: [{ type: "text", text: `Added retries to refreshSession (${choice}).` }] } });
emit({ type: "result", subtype: "success", is_error: false, num_turns: 3, total_cost_usd: sawNotes ? 0.4 : 0.5, usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 5000, cache_creation_input_tokens: 800 } });
