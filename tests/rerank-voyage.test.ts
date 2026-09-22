/**
 * VoyageReranker unit tests with stubbed fetch — no network, no API key.
 *
 * Same contract the Jev tests pin down: misaligned responses degrade to
 * `neural: false` passthrough (search.ts branches on it), usage meters only
 * on live 200s, and candidate text is truncated to the shared budget.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { VoyageReranker, voyageRerankMeter } from "../src/search/rerank-voyage.js";
import { RERANK_CONTENT_CHARS, RERANK_MODEL_WEIGHT } from "../src/search/reranker.js";

const candidates = [
  { id: "a", content: "Bundle size was 2.3MB so we rejected Monaco and chose CodeMirror.", score: 0.4 },
  { id: "b", content: "We should decide about the editor at some point.", score: 0.9 },
];

const ok = (data: unknown, usage = { total_tokens: 1000 }) =>
  new Response(JSON.stringify({ data, usage }), { status: 200 });

describe("VoyageReranker", () => {
  const realFetch = globalThis.fetch;
  const savedKey = process.env.VOYAGE_API_KEY;
  beforeEach(() => {
    voyageRerankMeter.reset();
    process.env.VOYAGE_API_KEY = "k";
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    if (savedKey === undefined) delete process.env.VOYAGE_API_KEY;
    else process.env.VOYAGE_API_KEY = savedKey;
    vi.unstubAllGlobals();
  });

  it("maps relevance scores back by index and blends like the others", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ok([
      { index: 0, relevance_score: 0.95 },
      { index: 1, relevance_score: 0.05 },
    ])));
    const out = await new VoyageReranker().rerank("why reject Monaco", candidates);
    expect(out[0].id).toBe("a");
    expect(out.every((x) => x.neural)).toBe(true);
    const expected = RERANK_MODEL_WEIGHT * 0.95 + (1 - RERANK_MODEL_WEIGHT) * 0.4;
    expect(out[0].combinedScore).toBeCloseTo(expected, 6);
    expect(voyageRerankMeter.requests).toBe(1);
    expect(voyageRerankMeter.tokens).toBe(1000);
  });

  it("degrades to passthrough when scores are short", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ok([{ index: 0, relevance_score: 0.9 }])));
    const out = await new VoyageReranker().rerank("q", candidates);
    expect(out.map((x) => x.id)).toEqual(["a", "b"]);
    expect(out.every((x) => !x.neural)).toBe(true);
  });

  it("degrades on HTTP failure without metering", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 429 })));
    const out = await new VoyageReranker().rerank("q", candidates);
    expect(out.every((x) => !x.neural)).toBe(true);
    expect(voyageRerankMeter.requests).toBe(0);
  });

  it("sends truncated documents and top_k in one request", async () => {
    const f = vi.fn(async () => ok([]));
    vi.stubGlobal("fetch", f);
    await new VoyageReranker().rerank("q", [{ id: "x", content: "z".repeat(5000), score: 0.1 }]);
    const body = JSON.parse((f.mock.calls[0][1] as { body: string }).body);
    expect(body.documents[0].length).toBe(RERANK_CONTENT_CHARS);
    expect(body.top_k).toBe(1);
    expect(typeof body.model).toBe("string");
  });

  it("passes through without a key", async () => {
    delete process.env.VOYAGE_API_KEY;
    const f = vi.fn(async () => ok([]));
    vi.stubGlobal("fetch", f);
    const out = await new VoyageReranker().rerank("q", candidates);
    expect(f).not.toHaveBeenCalled();
    expect(out.every((x) => !x.neural)).toBe(true);
  });
});
