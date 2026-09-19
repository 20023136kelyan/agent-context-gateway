/**
 * JevReranker unit tests against a fake client — no network, no API key.
 *
 * The assertions that matter most are the degradation ones. A fan-out response
 * is mapped back to candidates BY POSITION, so a short or reordered response
 * produces wrong scores in a plausible-looking order: it fails silently. Every
 * such path must return `neural: false`, because two callers downstream branch
 * on exactly that flag — `search.ts` (head length check) and
 * `extract.ts` (`if (!reranked.some(r => r.neural)) return candidates`).
 */
import { describe, it, expect, vi } from "vitest";
import { JevReranker } from "../src/judgments/rerank-jev.js";
import { RERANK_CONTENT_CHARS, RERANK_MODEL_WEIGHT } from "../src/search/rerank.js";
import type { JevClient } from "../src/judgments/jev.js";

const candidates = [
  { id: "a", content: "Bundle size was 2.3MB so we rejected Monaco and chose CodeMirror.", score: 0.4 },
  { id: "b", content: "We should decide about the editor at some point.", score: 0.9 },
  { id: "c", content: "The billing webhook is idempotent by event id.", score: 0.5 },
];

/** Returns a fixed noul per question id, in declaration order. */
const fakeClient = (values: number[], overrides: Partial<JevClient> = {}): JevClient => ({
  noul: vi.fn(async (_state, questions) => {
    const answers: Record<string, number> = {};
    Object.keys(questions).forEach((k, i) => {
      if (i < values.length) answers[k] = values[i];
    });
    return { answers };
  }),
  choice: vi.fn(async () => ({ answers: {} })),
  score: vi.fn(async () => ({ answers: {} })),
  ...overrides,
});

describe("JevReranker", () => {
  it("reorders by judgment, overriding a strong retrieval score", async () => {
    // "b" arrives ranked first (0.9) but answers nothing; "a" answers and is
    // ranked last (0.4). The judgment has to invert them.
    const r = new JevReranker("fanout", fakeClient([0.95, 0.05, 0.02]));
    const out = await r.rerank("why did we reject Monaco", candidates);
    expect(out[0].id).toBe("a");
    expect(out.every((x) => x.neural)).toBe(true);
  });

  it("blends with the same weight as the cross-encoder", async () => {
    const r = new JevReranker("fanout", fakeClient([0.5, 0, 0]));
    const out = await r.rerank("q", [candidates[0]]);
    const expected = RERANK_MODEL_WEIGHT * 0.5 + (1 - RERANK_MODEL_WEIGHT) * 0.4;
    expect(out[0].combinedScore).toBeCloseTo(expected, 6);
  });

  it("truncates candidates to the shared reranker budget", async () => {
    const client = fakeClient([0.5]);
    const r = new JevReranker("fanout", client);
    const long = { id: "x", content: "z".repeat(5000), score: 0.1 };
    await r.rerank("q", [long]);
    const state = (client.noul as ReturnType<typeof vi.fn>).mock.calls[0][0] as { candidates: string[] };
    expect(state.candidates[0].length).toBe(RERANK_CONTENT_CHARS);
  });

  it("degrades to retrieval order when the response is short", async () => {
    // Two answers for three candidates: positional mapping would silently
    // misalign. Must refuse rather than guess.
    const r = new JevReranker("fanout", fakeClient([0.9, 0.8]));
    const out = await r.rerank("q", candidates);
    expect(out.every((x) => !x.neural)).toBe(true);
    expect(out.map((x) => x.id)).toEqual(["a", "b", "c"]); // untouched order
  });

  it("degrades when the client throws", async () => {
    const r = new JevReranker("fanout", fakeClient([], { noul: vi.fn(async () => { throw new Error("jev-http-429"); }) }));
    const out = await r.rerank("q", candidates);
    expect(out.every((x) => !x.neural)).toBe(true);
    expect(out).toHaveLength(3);
  });

  it("returns empty for no candidates without calling the API", async () => {
    const client = fakeClient([]);
    const r = new JevReranker("fanout", client);
    expect(await r.rerank("q", [])).toEqual([]);
    expect(client.noul).not.toHaveBeenCalled();
  });

  it("honours topK", async () => {
    const r = new JevReranker("fanout", fakeClient([0.1, 0.2]));
    const out = await r.rerank("q", candidates, 2);
    expect(out).toHaveLength(2);
  });

  it("pairwise mode issues one request per candidate and judges each alone", async () => {
    const client: JevClient = {
      noul: vi.fn(async (state) => {
        const s = state as { candidate: string };
        // Score by content, proving each call saw only its own candidate.
        return { answers: { answers_query: s.candidate.includes("Monaco") ? 0.95 : 0.1 } };
      }),
      choice: vi.fn(async () => ({ answers: {} })),
      score: vi.fn(async () => ({ answers: {} })),
    };
    const r = new JevReranker("pairwise", client);
    const out = await r.rerank("why did we reject Monaco", candidates);
    expect(client.noul).toHaveBeenCalledTimes(3);
    expect(out[0].id).toBe("a");
  });

  it("is substitutable for the cross-encoder at the SearchService seam", async () => {
    // setReranker accepts Pick<CrossEncoderReranker, "rerank">; this is the
    // structural check that JevReranker satisfies it.
    const { SearchService } = await import("../src/search/search.js");
    const r = new JevReranker("fanout", fakeClient([1, 0, 0]));
    const svc = Object.create(SearchService.prototype) as InstanceType<typeof SearchService>;
    expect(() => svc.setReranker(r)).not.toThrow();
  });
});
