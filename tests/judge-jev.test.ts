/**
 * JevDecisionJudge unit tests against a fake client (Phase 3).
 *
 * The behaviour worth pinning is the decision-state damping. The heuristic
 * extractor matches conclusion-SHAPED language, so "we still need to decide
 * between Monaco and CodeMirror — no conclusions yet" reads to it as a decision.
 * A Score that separates `proposed` from `decided` is the only thing in the
 * pipeline that can tell them apart.
 */
import { describe, it, expect, vi } from "vitest";
import { JevDecisionJudge } from "../src/judgments/judge-jev.js";
import type { JevClient } from "../src/judgments/jev.js";
import type { ExtractedDecision } from "../src/decisions/extract.js";

const turn = (id: string, content: string) => ({
  id,
  sessionId: "s1",
  harness: "claude-code" as const,
  timestamp: "2026-03-01T00:00:00Z",
  role: "assistant" as const,
  content,
  seq: 0,
});

const decision = (id: string, content: string, confidence = 0.6): ExtractedDecision => ({
  method: "heuristic",
  confidence,
  conclusion: turn(id, content),
  rationale: [],
  alternatives: [],
  question: null,
  sessionId: "s1",
});

/** noul and score are keyed by the question id the judge chose. The fake
 *  answers only requested ids, like the wire: unasked questions stay absent. */
const client = (noul: number | undefined, score?: number): JevClient => ({
  noul: vi.fn(async () => ({ answers: noul === undefined ? {} : { answers_query: noul } })),
  score: vi.fn(async () => ({ answers: score === undefined ? {} : { decision_state: score } })),
  choice: vi.fn(async () => ({ answers: {} })),
  evaluate: vi.fn(async (_state, questions: Record<string, unknown>) => ({
    nouls: noul === undefined || !("answers_query" in questions) ? {} : { answers_query: noul },
    choices: {},
    scores: score === undefined || !("decision_state" in questions) ? {} : { decision_state: score },
  })),
});

describe("JevDecisionJudge", () => {
  it("blends the noul with heuristic confidence and relabels the method", async () => {
    const out = await new JevDecisionJudge(client(1.0, 1)).judge([decision("a", "We chose CodeMirror.")], "why");
    expect(out[0].method).toBe("jev");
    expect(out[0].decisionState).toBe("decided");
    // 0.65 * 1.0 + 0.35 * 0.6, undamped because it is `decided`
    expect(out[0].confidence).toBeCloseTo(0.86, 2);
  });

  it("damps a proposal that merely looks like a decision", async () => {
    const settled = await new JevDecisionJudge(client(0.8, 1)).judge([decision("a", "x")], "why");
    const proposed = await new JevDecisionJudge(client(0.8, 0)).judge([decision("a", "x")], "why");
    expect(proposed[0].decisionState).toBe("proposed");
    expect(proposed[0].confidence).toBeCloseTo(settled[0].confidence * 0.5, 3);
  });

  it("recognises a reversal as a real decision, not a proposal", async () => {
    const out = await new JevDecisionJudge(client(0.9, 2)).judge([decision("a", "x")], "why");
    expect(out[0].decisionState).toBe("reversed");
    expect(out[0].confidence).toBeGreaterThan(0.5); // undamped
  });

  it("sorts by judged confidence, overriding heuristic order", async () => {
    const c: JevClient = {
      noul: vi.fn(async (state) => {
        const s = state as { passage: string };
        return { answers: { answers_query: s.passage.includes("CodeMirror") ? 0.95 : 0.05 } };
      }),
      score: vi.fn(async () => ({ answers: { decision_state: 1 } })),
      choice: vi.fn(async () => ({ answers: {} })),
      evaluate: vi.fn(async (state) => {
        const s = state as { passage: string };
        return {
          nouls: { answers_query: s.passage.includes("CodeMirror") ? 0.95 : 0.05 },
          choices: {},
          scores: { decision_state: 1 },
        };
      }),
    };
    const out = await new JevDecisionJudge(c).judge(
      [decision("weak", "Unrelated chatter.", 0.9), decision("strong", "We chose CodeMirror.", 0.2)],
      "why did we reject Monaco",
    );
    expect(out[0].conclusion.id).toBe("strong");
  });

  it("leaves verdicts unlabelled when the model scored nothing", async () => {
    // `method` must never claim a judgment that did not happen — downstream
    // callers read it as provenance for the confidence number.
    const cands = [decision("a", "x")];
    const out = await new JevDecisionJudge(client(undefined)).judge(cands, "why");
    expect(out[0].method).toBe("heuristic");
    expect(out[0].confidence).toBe(0.6);
  });

  it("returns candidates untouched when the client throws", async () => {
    const c: JevClient = {
      noul: vi.fn(async () => { throw new Error("jev-http-429"); }),
      score: vi.fn(async () => ({ answers: {} })),
      choice: vi.fn(async () => ({ answers: {} })),
      evaluate: vi.fn(async () => { throw new Error("jev-http-429"); }),
    };
    const cands = [decision("a", "x")];
    const out = await new JevDecisionJudge(c).judge(cands, "why");
    expect(out).toEqual(cands);
  });

  it("no-ops without a query or candidates", async () => {
    const c = client(0.9, 1);
    expect(await new JevDecisionJudge(c).judge([], "why")).toEqual([]);
    const cands = [decision("a", "x")];
    expect(await new JevDecisionJudge(c).judge(cands, undefined)).toEqual(cands);
    expect(c.noul).not.toHaveBeenCalled();
  });

  it("omits the Score question entirely when state judging is off", async () => {
    const c = client(0.8, 0);
    const out = await new JevDecisionJudge(c, false).judge([decision("a", "x")], "why");
    const questions = (c.evaluate as ReturnType<typeof vi.fn>).mock.calls[0][1] as Record<string, unknown>;
    expect(Object.keys(questions)).toEqual(["answers_query"]);
    expect(out[0].decisionState).toBeUndefined();
    expect(out[0].confidence).toBeCloseTo(0.65 * 0.8 + 0.35 * 0.6, 3); // undamped
  });

  it("sends Noul and Score in one mixed request, not two", async () => {
    const c = client(0.9, 1);
    await new JevDecisionJudge(c).judge([decision("a", "x")], "why");
    expect(c.evaluate).toHaveBeenCalledTimes(1);
    expect(c.noul).not.toHaveBeenCalled();
    expect(c.score).not.toHaveBeenCalled();
    const questions = (c.evaluate as ReturnType<typeof vi.fn>).mock.calls[0][1] as Record<string, unknown>;
    expect(Object.keys(questions).sort()).toEqual(["answers_query", "decision_state"]);
  });
});
