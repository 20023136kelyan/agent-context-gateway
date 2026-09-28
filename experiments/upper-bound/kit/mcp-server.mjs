#!/usr/bin/env node
/**
 * Bifröst experiment MCP server (the pull channel).
 *
 * One tool, `bifrost_at`, returns the notes for a file. Used where notes can't be
 * pushed into the agent's context (Codex, Cursor), or as a pull-only arm.
 *
 * Environment: BIFROST_NOTES, BIFROST_LOG, BIFROST_ROOT (repo root; default cwd).
 */
import { appendFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { formatNotes, loadNotes, matchNotes, toRepoPath } from "./notes-lib.mjs";

function log(entry) {
  const file = process.env.BIFROST_LOG;
  if (!file) return;
  try { appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), channel: "pull", ...entry }) + "\n"); } catch { /* ignore */ }
}

export function lookup(path, env = process.env) {
  const root = env.BIFROST_ROOT || process.cwd();
  const rel = toRepoPath(path, root) ?? String(path).replace(/^\.\//, "");
  const notes = env.BIFROST_NOTES ? loadNotes(env.BIFROST_NOTES) : [];
  const matched = matchNotes(notes, [{ path: rel }]);
  const { text, shown } = formatNotes(matched, { maxNotes: 6, budgetChars: 2000 });
  return { rel, text: text || `No Bifröst notes for ${rel}.`, shown };
}

const server = new McpServer({ name: "bifrost", version: "0.0.1" });
server.tool(
  "bifrost_at",
  "Shared notes other agents left about a file: warnings, decisions, known issues and how-tos. Call it before you edit a file.",
  { path: z.string().describe("Repository-relative path of the file, e.g. src/authClient.js") },
  async ({ path }) => {
    const { rel, text, shown } = lookup(path);
    log({ tool: "bifrost_at", places: [rel], shown });
    return { content: [{ type: "text", text }] };
  },
);

await server.connect(new StdioServerTransport());
