/** Phase 3 decisions + temporal tests. */
import { describe, it, expect, beforeAll } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { extractDecisions, HeuristicJudge } from "../src/decisions/extract.js";
import { isWhyQuery } from "../src/decisions/cues.js";
import { normalizeQuery } from "../src/search/query.js";
import { createApp, closeApp, type GatewayApp } from "../src/app.js";
import { decideOnce } from "../src/commands.js";
import { syncAll } from "../src/indexing/sync.js";
import { CursorStore } from "../src/indexing/store.js";
import type { Turn } from "../src/core/models.js";
import { ClaudeAdapter } from "../src/adapters/claude.js";

const t = (seq: number, role: Turn["role"], content: string, ts = "2026-09-10T10:00:00Z"): Turn => ({
  id: `x:s:${seq}`, sessionId: "s", harness: "codex", timestamp: ts, role, content, raw: {}, seq,
});

describe("extractDecisions", () => {
  it("assembles conclusion + rationale + alternatives + question with high confidence", () => {
    const turns = [
      t(0, "user", "Should we replace Monaco with CodeMirror?"),
      t(1, "assistant", "Monaco licensing is problematic because legal must review it"),
      t(2, "assistant", "We decided to replace Monaco with CodeMirror because the MIT license avoids legal review"),
      t(3, "assistant", "We considered forking Monaco instead of replacing it"),
    ];
    const [d] = extractDecisions("s", turns);
    expect(d.method).toBe("heuristic");
    expect(d.confidence).toBe(1);
    expect(d.conclusion.seq).toBe(2);
    expect(d.rationale.map((x) => x.seq)).toContain(1);
    expect(d.alternatives.map((x) => x.seq)).toContain(3);
    expect(d.question?.seq).toBe(0);
  });

  it("weak cues score low; no cues yield nothing", () => {
    const [weak] = extractDecisions("s", [t(0, "assistant", "We should probably refactor this sometime")]);
    expect(weak.confidence).toBeLessThan(0.5);
    expect(extractDecisions("s", [t(0, "assistant", "The build passed in 42 seconds")])).toEqual([]);
  });

  it("tool echoes never anchor (selected/click false positives)", () => {
    const turns = [
      t(0, "assistant", "Checking the element state"),
      t(1, "tool", "actions[0] click: ok — element selected"),
    ];
    expect(extractDecisions("s", turns)).toEqual([]);
  });

  it("file contents echoed back by a tool never anchor (real Claude shape)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acg-dec-claude-"));
    const sid = "eeeeeeee-1111-2222-3333-444444444444";
    await mkdir(join(dir, "proj"), { recursive: true });
    const lines = [
      JSON.stringify({ type: "user", uuid: "u1", timestamp: "2026-09-10T10:00:00Z", sessionId: sid, cwd: "/repo/proj", message: { role: "user", content: "Why did we swap the editor?" } }),
      // A Read result — source code that happens to contain decision cues.
      JSON.stringify({ type: "user", uuid: "u2", timestamp: "2026-09-10T10:01:00Z", sessionId: sid, cwd: "/repo/proj", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "1\t/**\n2\t * We decided to keep Monaco here because the license was fine\n3\t */" }] } }),
      JSON.stringify({ type: "assistant", uuid: "a1", timestamp: "2026-09-10T10:02:00Z", sessionId: sid, cwd: "/repo/proj", message: { role: "assistant", content: [{ type: "text", text: "We decided to replace Monaco with CodeMirror because the MIT license avoids legal review" }] } }),
    ];
    await writeFile(join(dir, "proj", `${sid}.jsonl`), lines.join("\n"));
    const turns = await new ClaudeAdapter(dir).listTurns(sid);
    const decisions = extractDecisions(sid, turns, ["monaco", "replace"]);
    expect(decisions.map((d) => d.conclusion.content)).toEqual([
      "We decided to replace Monaco with CodeMirror because the MIT license avoids legal review",
    ]);
  });

  it("relevance gate demotes verdicts that ignore the query", () => {
    const turns = [
      t(0, "user", "Should we replace Monaco?"),
      t(1, "assistant", "We decided to replace Monaco because licensing is hostile"),
    ];
    const [matching] = extractDecisions("s", turns, ["monaco", "replace", "licensing"]);
    expect(matching.confidence).toBeGreaterThan(0.65);
    const [foreign] = extractDecisions("s", turns, ["zebracorn", "lighthouse", "tacos"]);
    expect(foreign.confidence).toBeLessThan(0.4);
    // No terms (legacy callers): ungated behavior preserved.
    const [plain] = extractDecisions("s", turns);
    expect(plain.confidence).toBeGreaterThanOrEqual(matching.confidence);
  });

  it("attributive adjectives don't anchor, real verdicts do", () => {
    const attr = extractDecisions("s", [t(0, "assistant", "I also isolated lookup to the selected session for safety")]);
    expect(attr).toEqual([]);
    const real = extractDecisions("s", [
      t(0, "assistant", "Postgres is boring technology because it just works"),
      t(1, "assistant", "We selected Postgres"),
    ]);
    expect(real).toHaveLength(1);
    expect(real[0].confidence).toBeGreaterThanOrEqual(0.8);
  });

  it("a '?' inside a URL or code doesn't turn a verdict into a question", () => {
    const [d] = extractDecisions("s", [t(0, "assistant", "We decided to ship it; details at https://example.com/pr?id=42 for review")]);
    expect(d?.conclusion.seq).toBe(0);
  });

  it("the heuristic judge passes candidates through labelled as heuristic", async () => {
    const cands = extractDecisions("s", [t(0, "user", "Why replace Kafka?"), t(1, "assistant", "We decided to replace Kafka because it is too heavy")], ["replace", "kafka"]);
    const judged = await new HeuristicJudge().judge(cands, "Why replace Kafka?");
    expect(judged[0].method).toBe("heuristic");
    expect(judged[0].confidence).toBe(cands[0].confidence);
  });

  it("why-routing", () => {
    expect(isWhyQuery("Why did we reject Monaco?")).toBe(true);
    expect(isWhyQuery("What files changed?")).toBe(false);
  });
});

describe("temporal query parsing", () => {
  const now = new Date("2026-09-15T12:00:00Z");
  it("intervals", () => {
    expect(normalizeQuery("x between 2026-09-01 and 2026-09-05", now).after).toBe("2026-09-01T00:00:00.000Z");
    // The end date is inclusive: "before" (exclusive) is the following midnight.
    expect(normalizeQuery("x between 2026-09-01 and 2026-09-05", now).before).toBe("2026-09-06T00:00:00.000Z");
    expect(normalizeQuery("x since 2026-09-10", now).after).toBe("2026-09-10T00:00:00.000Z");
    expect(normalizeQuery("x last 3 days", now).after).toBe("2026-09-12T12:00:00.000Z");
    expect(normalizeQuery("x this week", now).after).toBe("2026-09-14T00:00:00.000Z"); // Mon Sep 14
  });
});

describe("decideOnce", () => {
  let app: GatewayApp;
  beforeAll(async () => {
    const root = await mkdtemp(join(tmpdir(), "acg-dec-"));
    const codexDir = join(root, "codex");
    await mkdir(join(codexDir, "2026", "09", "10"), { recursive: true });
    const sess = (id: string, texts: string[]) =>
      [
        JSON.stringify({ timestamp: "2026-09-10T09:00:00Z", ordinal: 0, type: "session_meta", payload: { session_id: id, cwd: "/repo/cozea" } }),
        ...texts.map((text, i) =>
          JSON.stringify({ timestamp: `2026-09-10T09:${String(i + 1).padStart(2, "0")}:00Z`, ordinal: i + 1, type: "response_item", payload: { type: "message", id: `m${i}`, role: i % 2 ? "assistant" : "user", content: [{ type: "output_text", text }] } }),
        ),
      ].join("\n");
    await writeFile(join(codexDir, "2026", "09", "10", "r1.jsonl"), sess("dddddddd-1111-1111-1111-111111111111", [
      "Should we adopt the new queue design?",
      "The old queue drops messages because it lacks persistence",
      "We decided to adopt the new queue design since persistence avoids data loss",
      "We considered patching the old queue instead",
    ]));
    await writeFile(join(codexDir, "2026", "09", "10", "r2.jsonl"), sess("dddddddd-2222-2222-2222-222222222222", [
      "What is for lunch",
      "Tacos are good",
    ]));
    app = createApp({ indexDir: join(root, "index"), codexDir, claudeDir: join(root, "empty"), backend: "tantivy", cursorDb: join(root, "nope.vscdb") });
    await syncAll(app.adapters, app.index, new CursorStore(join(root, "index")));
  });

  it("returns the decision with rationale, alternatives and provenance", async () => {
    // The judge is pinned, not inherited. `decideOnce` resolves one from the
    // ambient environment, so with TYPESAFE_API_KEY exported this asserted
    // a vendor method against a heuristic verdict — a developer with a key
    // got a failing suite, and the test reached a third-party API to do it.
    const res = await decideOnce(app, "Why did we adopt the new queue design?", {
      judge: new HeuristicJudge(),
    });
    expect(res.whyRouted).toBe(true);
    expect(res.decisions.length).toBeGreaterThanOrEqual(1);
    const top = res.decisions[0];
    expect(top.method).toBe("heuristic");
    expect(top.confidence).toBeGreaterThanOrEqual(0.6);
    expect(top.session.sessionId).toBe("dddddddd-1111-1111-1111-111111111111");
    expect(top.conclusion.content).toMatch(/decided/);
    expect(top.rationale.map((r) => r.content).join(" ")).toMatch(/persistence/);
    expect(top.alternatives.map((a) => a.content).join(" ")).toMatch(/patching/);
    closeApp(app);
  });
});
