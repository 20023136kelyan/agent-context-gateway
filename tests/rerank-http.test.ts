/**
 * Self-hosted reranker: reply shapes, logit scores, templates, degradation.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { HttpReranker, readScores, toProbabilities } from "../src/search/rerank-http.js";

describe("readScores", () => {
  it("reads vLLM/Cohere, Voyage and TEI replies", () => {
    expect([...readScores({ results: [{ index: 1, relevance_score: 0.9 }, { index: 0, relevance_score: 0.2 }] })]).toEqual([[1, 0.9], [0, 0.2]]);
    expect([...readScores({ data: [{ index: 0, relevance_score: 0.5 }] })]).toEqual([[0, 0.5]]);
    expect([...readScores([{ index: 0, score: 3.1 }])]).toEqual([[0, 3.1]]);
    expect(readScores({ error: "boom" }).size).toBe(0);
  });

  it("squashes a batch of logits and leaves probabilities alone", () => {
    expect(toProbabilities([0.2, 0.9])).toEqual([0.2, 0.9]);
    const p = toProbabilities([-2, 0.5, 4]);
    expect(p.every((x) => x > 0 && x < 1)).toBe(true);
    expect(p[2]! > p[1]! && p[1]! > p[0]!).toBe(true);
  });
});

describe("HttpReranker", () => {
  let server: Server;
  let url: string;
  const seen: { query: string; documents: string[]; model?: string }[] = [];
  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const b = JSON.parse(body) as { query: string; documents: string[]; model?: string };
        seen.push(b);
        if (b.query.includes("fail")) {
          res.writeHead(500).end();
          return;
        }
        // Scores the document mentioning "planId" highest.
        const results = b.documents.map((d, index) => ({ index, relevance_score: d.includes("planId") ? 0.95 : 0.1 }));
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ results }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/rerank`;
  });
  afterAll(() => server.close());

  const pool = [
    { id: "a", content: "the billing page layout", score: 0.9 },
    { id: "b", content: "getUserPlan throws reading planId", score: 0.4 },
  ];

  it("reorders by the model's score, blended with retrieval", async () => {
    const out = await new HttpReranker({ url, model: "m" }).rerank("why is the plan wrong", pool);
    expect(out.map((r) => r.id)).toEqual(["b", "a"]);
    expect(out.every((r) => r.neural)).toBe(true);
    expect(seen.at(-1)?.model).toBe("m");
  });

  it("fills the query and document templates", async () => {
    await new HttpReranker({ url, queryTemplate: "Q: {query}", docTemplate: "D: {doc}" }).rerank("plan", pool);
    expect(seen.at(-1)?.query).toBe("Q: plan");
    expect(seen.at(-1)?.documents[0]).toBe("D: the billing page layout");
  });

  it("keeps retrieval order when the endpoint fails or is not configured", async () => {
    const failed = await new HttpReranker({ url }).rerank("fail please", pool);
    expect(failed.map((r) => r.id)).toEqual(["a", "b"]);
    expect(failed.every((r) => !r.neural)).toBe(true);
    const none = await new HttpReranker(null).rerank("plan", pool);
    expect(none.every((r) => !r.neural)).toBe(true);
  });
});
