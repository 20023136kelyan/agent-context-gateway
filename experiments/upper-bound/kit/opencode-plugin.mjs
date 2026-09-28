/**
 * Bifröst experiment plugin for OpenCode: push delivery.
 *
 * OpenCode plugins can't add context before a tool runs, so notes are appended to the
 * tool's result instead: the agent sees them right after reading or editing the file.
 * Same matching, ranking, budget and once-per-session rules as hook.mjs, same
 * environment variables (BIFROST_NOTES, BIFROST_MODE, BIFROST_LOG, BIFROST_STATE).
 *
 * Loaded by the harness through OPENCODE_CONFIG_CONTENT ({"plugin": ["file://…/opencode-plugin.mjs"]}),
 * so nothing is written into the agent's workspace. Only the plugin is exported:
 * OpenCode treats every export as a plugin.
 */
import { handle } from "./hook.mjs";
import { fromOpenCodeCall } from "./notes-lib.mjs";

export const BifrostPlugin = async ({ directory, worktree }) => ({
  "tool.execute.after": async (input, output) => {
    const { tool, input: toolInput } = fromOpenCodeCall(input.tool, input.args);
    const text = handle({ tool_name: tool, tool_input: toolInput, session_id: input.sessionID, cwd: worktree || directory });
    if (text && output && typeof output.output === "string") output.output = `${output.output}\n\n${text}`;
  },
});
