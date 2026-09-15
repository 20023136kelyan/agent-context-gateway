/**
 * M1 adapter tests — synthetic fixtures mirroring real native shapes
 * (Claude §~/.claude/projects/<slug>/<id>.jsonl, Codex rollout-*.jsonl).
 * No real user content; validates parsing, IDs, provenance fields.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ClaudeAdapter } from "../src/adapters/claude.js";
import { CodexAdapter } from "../src/adapters/codex.js";

let claudeDir: string;
let codexDir: string;
const CLAUDE_SESSION = "11111111-2222-3333-4444-555555555555";
const CODEX_SESSION = "019f73a0-9b73-77a0-ac30-2984a0443ab5";

beforeAll(async () => {
  const root = await mkdtemp(join(tmpdir(), "acg-m1-"));

  // --- Claude fixture ---
  claudeDir = join(root, "claude");
  await mkdir(join(claudeDir, "my-proj"), { recursive: true });
  const claudeLines = [
    JSON.stringify({ type: "custom-title", customTitle: "x", sessionId: CLAUDE_SESSION }),
    JSON.stringify({
      parentUuid: null, type: "user", uuid: "u-1", timestamp: "2026-09-01T10:00:00Z",
      sessionId: CLAUDE_SESSION, cwd: "/repo/cozea", gitBranch: "main",
      message: { role: "user", content: "Investigate collaboration architecture in src/collab" },
    }),
    JSON.stringify({
      parentUuid: "u-1", type: "assistant", uuid: "a-1", timestamp: "2026-09-01T10:01:00Z",
      sessionId: CLAUDE_SESSION, cwd: "/repo/cozea",
      message: { role: "assistant", content: [{ type: "text", text: "Session workbench should remain private. Files are the shared primitive. See PR #169." }] },
    }),
    JSON.stringify({ type: "queue-operation", operation: "enqueue", sessionId: CLAUDE_SESSION }),
    JSON.stringify({
      parentUuid: "a-1", type: "assistant", uuid: "a-2", timestamp: "2026-09-01T10:02:00Z",
      sessionId: CLAUDE_SESSION, cwd: "/repo/cozea",
      message: { role: "assistant", content: [{ type: "tool_use", name: "Read", input: {} }, { type: "text", text: "checked src/collab/hub.ts" }] },
    }),
  ];
  await writeFile(join(claudeDir, "my-proj", `${CLAUDE_SESSION}.jsonl`), claudeLines.join("\n"));

  // --- Codex fixture ---
  codexDir = join(root, "codex");
  await mkdir(join(codexDir, "2026", "09", "14"), { recursive: true });
  const codexLines = [
    JSON.stringify({ timestamp: "2026-09-01T09:00:00Z", ordinal: 0, type: "session_meta", payload: { session_id: CODEX_SESSION, cwd: "/repo/cozea", originator: "test" } }),
    JSON.stringify({ timestamp: "2026-09-01T09:01:00Z", ordinal: 1, type: "response_item", payload: { type: "message", id: "m1", role: "user", content: [{ type: "input_text", text: "What was decided about collaboration?" }] } }),
    JSON.stringify({ timestamp: "2026-09-01T09:02:00Z", ordinal: 2, type: "response_item", payload: { type: "message", id: "m2", role: "assistant", content: [{ type: "output_text", text: "Files are the shared primitive per src/collab work." }] } }),
    JSON.stringify({ timestamp: "2026-09-01T09:03:00Z", ordinal: 3, type: "event_msg", payload: { type: "thread_started" } }),
    JSON.stringify({ timestamp: "2026-09-01T09:04:00Z", ordinal: 4, type: "response_item", payload: { type: "reasoning", id: "rs1", summary: [{ type: "summary_text", text: "Considering collaboration tradeoffs" }] } }),
    JSON.stringify({ timestamp: "2026-09-01T09:05:00Z", ordinal: 5, type: "response_item", payload: { type: "reasoning", id: "rs2", summary: [], content: null, encrypted_content: "gAAAAA..." } }),
    JSON.stringify({ timestamp: "2026-09-01T09:06:00Z", ordinal: 6, type: "response_item", payload: { type: "custom_tool_call", id: "c1", status: "completed", call_id: "call_1", name: "exec", input: "ls src/collab" } }),
  ];
  await writeFile(join(codexDir, "2026", "09", "14", `rollout-2026-09-14T00-00-00-${CODEX_SESSION}.jsonl`), codexLines.join("\n"));
});

describe("ClaudeAdapter", () => {
  it("lists sessions with project/workspace/provenance", async () => {
    const a = new ClaudeAdapter(claudeDir);
    const sessions = await a.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe(CLAUDE_SESSION);
    expect(sessions[0].harness).toBe("claude-code");
    expect(sessions[0].projectId).toBe("my-proj");
    expect(sessions[0].workspace).toBe("/repo/cozea");
    expect(sessions[0].sourcePath).toContain(CLAUDE_SESSION);
  });

  it("parses user/assistant turns, skips metadata, extracts fileRefs + tools", async () => {
    const a = new ClaudeAdapter(claudeDir);
    const turns = await a.listTurns(CLAUDE_SESSION);
    expect(turns.map((t) => t.role)).toEqual(["user", "assistant", "assistant"]);
    expect(turns[0].content).toContain("collaboration");
    expect(turns[1].fileRefs).toContain("PR #169");
    expect(turns[2].toolNames).toContain("Read");
    // stable IDs + provenance fields
    for (const t of turns) {
      expect(t.id).toContain("claude-code");
      expect(t.sessionId).toBe(CLAUDE_SESSION);
      expect(t.timestamp).toBeTruthy();
      expect(t.byteOffset).toBeGreaterThanOrEqual(0);
    }
  });

  it("getTurn round-trips", async () => {
    const a = new ClaudeAdapter(claudeDir);
    const turns = await a.listTurns(CLAUDE_SESSION);
    const one = await a.getTurn(CLAUDE_SESSION, turns[1].id);
    expect(one.content).toBe(turns[1].content);
  });
});

describe("CodexAdapter", () => {
  it("lists sessions from session_meta", async () => {
    const a = new CodexAdapter(codexDir);
    const sessions = await a.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe(CODEX_SESSION);
    expect(sessions[0].harness).toBe("codex");
    expect(sessions[0].workspace).toBe("/repo/cozea");
  });

  it("parses messages + reasoning summary + tool calls, skips encrypted/usage", async () => {
    const a = new CodexAdapter(codexDir);
    const turns = await a.listTurns(CODEX_SESSION);
    // m1 user, m2 assistant, rs1 reasoning->assistant, c1 tool
    expect(turns.map((t) => t.role)).toEqual(["user", "assistant", "assistant", "tool"]);
    expect(turns[0].content).toContain("collaboration");
    expect(turns[2].content).toContain("tradeoffs");
    expect(turns[3].toolNames).toContain("exec");
    for (const t of turns) {
      expect(t.id).toContain("codex");
      expect(t.byteOffset).toBeGreaterThanOrEqual(0);
    }
  });
});
