/**
 * §78 acceptance — the MVP completeness scenario.
 *
 * Session A (Codex, project cozea) discusses + resolves the collaboration
 * architecture. Session B (Claude, project cozea) later asks what Codex
 * decided. Distractor sessions (Monaco, lunch) must not pollute results.
 *
 * Each numbered assertion maps to a §78(triple-backtick) requirement step.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { mkdtemp, mkdir, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp, closeApp, type GatewayApp } from "../src/app.js";
import { searchOnce, getTurn, listSessions } from "../src/commands.js";

const CODEX_A = "aaaaaaaa-1111-2222-3333-444444444444"; // the architecture session
const CODEX_X = "aaaaaaaa-5555-6666-7777-888888888888"; // distractor: Monaco
const CLAUDE_B = "bbbbbbbb-1111-2222-3333-444444444444"; // the querier
const CLAUDE_Y = "bbbbbbbb-5555-6666-7777-888888888888"; // distractor: lunch

let app: GatewayApp;
let claudeDir: string;
let codexDir: string;
let filesBefore: string[];

function codexSession(id: string, texts: string[]): string[] {
  return [
    JSON.stringify({ timestamp: "2026-09-10T09:00:00Z", ordinal: 0, type: "session_meta", payload: { session_id: id, cwd: "/repo/cozea" } }),
    ...texts.map((t, i) =>
      JSON.stringify({ timestamp: `2026-09-10T09:${String(i + 1).padStart(2, "0")}:00Z`, ordinal: i + 1, type: "response_item", payload: { type: "message", id: `m${i}`, role: i % 2 ? "assistant" : "user", content: [{ type: "input_text", text: t }] } }),
    ),
  ];
}

function claudeSession(id: string, texts: string[]): string[] {
  return texts.map((t, i) =>
    JSON.stringify({
      parentUuid: null, type: i % 2 ? "assistant" : "user", uuid: `u-${i}`,
      timestamp: `2026-09-10T10:${String(i).padStart(2, "0")}:00Z`,
      sessionId: id, cwd: "/repo/cozea",
      message: i % 2
        ? { role: "assistant", content: [{ type: "text", text: t }] }
        : { role: "user", content: t },
    }),
  );
}

beforeAll(async () => {
  const root = await mkdtemp(join(tmpdir(), "acg-accept-"));
  claudeDir = join(root, "claude");
  codexDir = join(root, "codex");
  await mkdir(join(claudeDir, "cozea"), { recursive: true });
  await mkdir(join(codexDir, "2026", "09", "10"), { recursive: true });

  // Session A — the architectural decision (spec §62 example content).
  await writeFile(
    join(codexDir, "2026", "09", "10", `rollout-2026-09-10T00-00-00-${CODEX_A}.jsonl`),
    codexSession(CODEX_A, [
      "Investigate the collaboration architecture for Cozea",
      "The session workbench should remain private to each participant",
      "Files are the shared primitive across sessions",
      "Autogit should ask before rebasing from main",
    ]).join("\n"),
  );
  // Distractor X — same harness + project, different topic.
  await writeFile(
    join(codexDir, "2026", "09", "10", `rollout-2026-09-10T00-00-01-${CODEX_X}.jsonl`),
    codexSession(CODEX_X, [
      "Investigate the Monaco editor integration",
      "Monaco should be replaced with CodeMirror for licensing reasons",
    ]).join("\n"),
  );
  // Session B — the querier (exists, but holds no answer).
  await writeFile(
    join(claudeDir, "cozea", `${CLAUDE_B}.jsonl`),
    claudeSession(CLAUDE_B, ["Starting work on the Cozea project"]).join("\n"),
  );
  // Distractor Y — different topic.
  await writeFile(
    join(claudeDir, "cozea", `${CLAUDE_Y}.jsonl`),
    claudeSession(CLAUDE_Y, ["Where should the team go for lunch today", "Tacos sound good"]).join("\n"),
  );

  filesBefore = [...(await readdir(join(claudeDir, "cozea"))), ...(await readdir(join(codexDir, "2026", "09", "10")))].sort();
  app = createApp({ indexDir: join(root, "index"), claudeDir, codexDir, backend: "tantivy", cursorDb: join(root, "no-cursor.vscdb") });
});

describe("§78 acceptance", () => {
  it("two independent sessions exist across harnesses", async () => {
    const sessions = await listSessions(app);
    expect(sessions.map((s) => s.id)).toEqual(expect.arrayContaining([CODEX_A, CLAUDE_B]));
  });

  it("§78 steps 1–10: Codex decision retrievable by a Claude-side query", async () => {
    const t0 = Date.now();
    const res = await searchOnce(app, "What did Codex decide about the collaboration architecture?", { harness: "codex" });
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(30000);

    // (2) search finds something
    expect(res.results.length).toBeGreaterThanOrEqual(1);
    const top = res.results[0];

    // (1) relevant Codex history identified
    expect(top.provenance.harness).toBe("codex");

    // (3) the relevant discussion located (Session A, not distractor X)
    expect(top.provenance.sessionId).toBe(CODEX_A);

    // (4) enough surrounding context to understand the decision
    const ctxText = top.context.map((t) => t.content).join("\n");
    expect(top.context.length).toBeGreaterThan(1);
    expect(ctxText).toMatch(/private/);
    expect(ctxText).toMatch(/shared primitive/);

    // (5) concise: summary shorter than full evidence
    expect(top.summary.length).toBeGreaterThan(0);
    expect(top.summary.length).toBeLessThan(ctxText.length);

    // (6–7) session + turns identified
    expect(top.provenance.sessionId).toBe(CODEX_A);
    expect(top.provenance.turnId).toBeTruthy();
    expect(top.provenance.timestamp).toBeTruthy();
    expect(top.provenance.sourcePath).toContain(CODEX_A);

    // (8) turns directly retrievable and identical
    const direct = await getTurn(app, "codex", CODEX_A, top.provenance.turnId);
    const center = top.context.find((t) => t.id === top.provenance.turnId);
    expect(direct.content).toBe(center?.content);

    // (9) unrelated history avoided in top results
    const topSessions = res.results.slice(0, 3).map((r) => r.provenance.sessionId);
    expect(topSessions).not.toContain(CODEX_X);
    expect(topSessions).not.toContain(CLAUDE_Y);

    // (10) no manual memory: fixtures hold native histories only, and the
    // gateway wrote nothing into source dirs (index lives elsewhere).
    const filesAfter = [...(await readdir(join(claudeDir, "cozea"))), ...(await readdir(join(codexDir, "2026", "09", "10")))].sort();
    expect(filesAfter).toEqual(filesBefore);
    expect(filesAfter.every((f) => f.endsWith(".jsonl"))).toBe(true);
  });
});
