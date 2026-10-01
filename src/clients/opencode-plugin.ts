/**
 * Bifröst for OpenCode. OpenCode loads this file as a plugin (`bifrost install
 * opencode`); it runs inside OpenCode, so it calls the daemon directly.
 *
 * - Before a tool runs, the notes for the places its arguments name are fetched;
 *   after it runs, they are appended to its result, with no waiting at that point.
 * - The fixed explanation comes from an instructions file in OpenCode's config; the
 *   project's own notes are fetched before the session's first tool call and appended
 *   to its result.
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
  args?: unknown;
}

export const BifrostPlugin = async ({ directory, worktree }: { directory?: string; worktree?: string }) => {
  const cwd = worktree || directory || process.cwd();
  const started = new Set<string>();
  const pending = new Map<string, string>();
  const key = (i: ToolInput) => `${i.sessionID}:${i.callID ?? i.tool}`;

  return {
    "tool.execute.before": async (input: ToolInput, output: ToolOutput) => {
      try {
        const parts: string[] = [];
        if (!started.has(input.sessionID)) {
          started.add(input.sessionID);
          const project = await deliver("/session", { cwd, session: input.sessionID, client: "opencode", explain: false }, CLI_PATH);
          if (project.text) parts.push(project.text);
        }
        const { tool, input: args } = fromOpenCodeCall(input.tool, output?.args ?? input.args);
        const notes = await deliver("/tool", { cwd, session: input.sessionID, client: "opencode", tool, input: args }, CLI_PATH);
        if (notes.text) parts.push(notes.text);
        if (parts.length) pending.set(key(input), parts.join("\n"));
      } catch {
        /* never break a tool call */
      }
    },
    "tool.execute.after": async (input: ToolInput, output: ToolOutput) => {
      const text = pending.get(key(input));
      if (text === undefined) return;
      pending.delete(key(input));
      if (typeof output?.output === "string") output.output = `${output.output}\n\n${text}`;
    },
  };
};
