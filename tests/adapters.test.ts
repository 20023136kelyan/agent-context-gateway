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
    // A tool result: wears the "user" type natively, but it is file content.
    JSON.stringify({
      parentUuid: "a-2", type: "user", uuid: "u-2", timestamp: "2026-09-01T10:03:00Z",
      sessionId: CLAUDE_SESSION, cwd: "/repo/cozea",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t-1", content: "1\t/** We decided the workbench stays private */" }] },
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
    // The trailing tool_result line is tool output, not the user speaking.
    expect(turns.map((t) => t.role)).toEqual(["user", "assistant", "assistant", "tool"]);
    expect(turns[0].content).toContain("collaboration");
    expect(turns[1].fileRefs).toContain("PR #169");
    expect(turns[2].toolNames).toContain("Read");
    // Still indexed and searchable — only its role changed.
    expect(turns[3].content).toContain("workbench stays private");
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

describe("CodexAdapter: multi-agent runs", () => {
  // Codex Desktop subagents carry their PARENT's id in `session_id` and their
  // own in `id`. Reading session_id first once collapsed a 15-agent run into
  // one session, leaving 14 agents' work unfindable.
  const PARENT = "019f6c2c-0000-7000-8000-000000000001";
  const CHILDREN = ["019f6c2d-0000-7000-8000-000000000002", "019f6c37-0000-7000-8000-000000000003"];
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "acg-codex-multi-"));
    const day = join(dir, "2026", "07", "16");
    await mkdir(day, { recursive: true });
    const file = async (id: string, meta: Record<string, unknown>, text: string, minute: number) =>
      writeFile(
        join(day, `rollout-2026-07-16T12-${String(minute).padStart(2, "0")}-00-${id}.jsonl`),
        [
          JSON.stringify({ timestamp: `2026-07-16T12:${String(minute).padStart(2, "0")}:00Z`, type: "session_meta", payload: { cwd: "/repo/cozea", ...meta } }),
          JSON.stringify({ timestamp: `2026-07-16T12:${String(minute).padStart(2, "0")}:30Z`, type: "response_item", payload: { type: "message", id: `m-${id}`, role: "user", content: [{ type: "input_text", text }] } }),
        ].join("\n"),
      );
    await file(PARENT, { id: PARENT, session_id: PARENT }, "Plan the backend audit", 0);
    await file(CHILDREN[0], { id: CHILDREN[0], session_id: PARENT, forked_from_id: PARENT }, "Audit the backend discovery path", 1);
    await file(CHILDREN[1], { id: CHILDREN[1], session_id: PARENT, forked_from_id: PARENT }, "Audit the devapp backend wiring", 2);
  });

  it("lists every subagent as its own session", async () => {
    const ids = (await new CodexAdapter(dir).listSessions()).map((s) => s.id).sort();
    expect(ids).toEqual([PARENT, ...CHILDREN].sort());
  });

  it("reads a subagent's own turns, not its parent's", async () => {
    const a = new CodexAdapter(dir);
    await a.listSessions();
    const turns = await a.listTurns(CHILDREN[1]);
    expect(turns.map((t) => t.content)).toEqual(["Audit the devapp backend wiring"]);
  });
});

describe("Codex tool calls are indexed with their arguments", () => {
  // function_call keeps its arguments in `arguments`; the adapter read `input`
  // and indexed every shell call as `shell("")`.
  //
  // Claude tool_use calls are deliberately NOT turns: emitting them as their
  // own turns cost the Jev pipeline 0.06 NDCG@5 on real history (broad set,
  // 0.613 over 4 runs -> 0.555 over 3), because ~13k short, keyword-dense
  // "Edit: path" turns crowded the rerank pool. Actions get their own index.
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "acg-actions-"));
    await mkdir(join(dir, "codex", "2026", "09", "01"), { recursive: true });
    await writeFile(
      join(dir, "codex", "2026", "09", "01", "rollout-x.jsonl"),
      [
        { timestamp: "2026-09-01T09:00:00Z", type: "session_meta", payload: { id: "cx1", cwd: "/repo" } },
        { timestamp: "2026-09-01T09:01:00Z", type: "response_item", payload: { type: "function_call", id: "f1", name: "shell", arguments: JSON.stringify({ command: ["bash", "-lc", "npm run db:migrate"] }), call_id: "c1" } },
      ].map((l) => JSON.stringify(l)).join("\n"),
    );
  });

  it("reads shell commands from `arguments`, joined into readable text", async () => {
    const a = new CodexAdapter(join(dir, "codex"));
    const [session] = await a.listSessions();
    const turns = await a.listTurns(session.id);
    expect(turns.map((t) => t.content)).toContain("shell(bash -lc npm run db:migrate)");
  });
});
