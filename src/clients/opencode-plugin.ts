/**
 * Bifröst for OpenCode. OpenCode loads this file as a plugin (`bifrost install
 * opencode`); it runs inside OpenCode, so it calls the daemon directly.
 *
 * - After each tool call, notes for the places it touched are appended to the tool
 *   result (OpenCode has no hook before the call).
 * - The fixed explanation comes from an instructions file in OpenCode's config; the
 *   project's own notes are appended to the session's first tool result.
 */
import { fileURLToPath } from "node:url";
import { deliver } from "../daemon/client.js";
import { fromOpenCodeCall } from "../delivery/places.js";

const CLI_PATH = fileURLToPath(new URL("../cli.js", import.meta.url));

interface ToolInput {
  tool: string;
  sessionID: string;
  callID?: string;
  args?: unknown;
}
interface ToolOutput {
  title?: string;
  output?: unknown;
  metadata?: unknown;
}

export const BifrostPlugin = async ({ directory, worktree }: { directory?: string; worktree?: string }) => {
  const cwd = worktree || directory || process.cwd();
  const started = new Set<string>();
  return {
    "tool.execute.after": async (input: ToolInput, output: ToolOutput) => {
      try {
        if (typeof output?.output !== "string") return;
        const parts: string[] = [];
        if (!started.has(input.sessionID)) {
          started.add(input.sessionID);
          const project = await deliver("/session", { cwd, session: input.sessionID, client: "opencode", explain: false }, CLI_PATH);
          if (project.text) parts.push(project.text);
        }
        const { tool, input: args } = fromOpenCodeCall(input.tool, input.args);
        const notes = await deliver("/tool", { cwd, session: input.sessionID, client: "opencode", tool, input: args }, CLI_PATH);
        if (notes.text) parts.push(notes.text);
        if (parts.length) output.output = `${output.output}\n\n${parts.join("\n")}`;
      } catch {
        /* never break a tool call */
      }
    },
  };
};
