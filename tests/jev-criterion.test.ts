/**
 * The Jev rerank criterion (JEV_RERANK_CRITERION). "answer" asks whether a
 * candidate contains the answer; "work" asks whether the earlier session is
 * relevant prior work, which is what a "continue that" request needs.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { JevReranker, jevCriterion } from "../src/judgments/rerank-jev.js";
import type { JevClient } from "../src/judgments/jev.js";

const pool = [
  { id: "a", content: "Added backend/silwall/risk.py with the portfolio risk score.", score: 0.5 },
  { id: "b", content: "Styled the landing page hero.", score: 0.4 },
];

function capturing() {
  const asked: { instructions: string; criteria?: { true: string; false: string } }[] = [];
  const client = {
    noul: vi.fn(async (_state: unknown, questions: Record<string, { instructions: string; criteria?: { true: string; false: string } }>) => {
      asked.push(...Object.values(questions));
      return { answers: Object.fromEntries(Object.keys(questions).map((k) => [k, 0.5])) };
    }),
  } as unknown as JevClient;
  return { asked, client };
}

afterEach(() => {
  delete process.env.JEV_RERANK_CRITERION;
});

describe("Jev rerank criterion", () => {
  it("defaults to asking for the answer", async () => {
    expect(jevCriterion()).toBe("answer");
    const { asked, client } = capturing();
    await new JevReranker("pairwise", client).rerank("continue the risk work", pool);
    expect(asked[0].instructions).toMatch(/contain the answer/);
  });

  it("asks about relevant prior work when set to `work`, in both scoring modes", async () => {
    process.env.JEV_RERANK_CRITERION = "work";
    for (const mode of ["pairwise", "fanout"] as const) {
      const { asked, client } = capturing();
      await new JevReranker(mode, client).rerank("continue the risk work", pool);
      expect(asked.length).toBe(2);
      for (const q of asked) {
        expect(q.instructions).toMatch(/relevant prior work/);
        expect(q.criteria?.true).toMatch(/continue, check or redo/);
      }
    }
  });

  it("treats any other value as the default", () => {
    process.env.JEV_RERANK_CRITERION = "nonsense";
    expect(jevCriterion()).toBe("answer");
  });
});
