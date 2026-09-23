/**
 * Key proxy (src/proxy/) and client routing (src/vendors.ts).
 * Upstream vendors are a local Fastify server: real HTTP on both hops, no stubs.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { ProxyStore } from "../src/proxy/store.js";
import { buildProxyServer } from "../src/proxy/server.js";
import { vendorTarget } from "../src/vendors.js";
import { embedDocuments, VOYAGE_GENERAL } from "../src/embeddings/voyage.js";

const SERVER_VOYAGE_KEY = "server-voyage-key";
const SECRET = "gh" + "p_" + "a1B2".repeat(9);

let upstream: FastifyInstance;
let upstreamUrl: string;
const received: { path: string; auth: string | undefined; body: Record<string, unknown> }[] = [];
let upstreamStatus = 200;

beforeAll(async () => {
  upstream = Fastify();
  upstream.post("/v1/embeddings", async (req, reply) => {
    const body = req.body as { input: string[] };
    received.push({ path: "/v1/embeddings", auth: req.headers.authorization, body: body as unknown as Record<string, unknown> });
    if (upstreamStatus !== 200) return reply.code(upstreamStatus).send({ detail: "bad input" });
    return { data: body.input.map((_s, index) => ({ index, embedding: new Array(VOYAGE_GENERAL.dim).fill(0) })), usage: { total_tokens: 1000 } };
  });
  upstream.post("/v1/rerank", async (req) => {
    received.push({ path: "/v1/rerank", auth: req.headers.authorization, body: req.body as Record<string, unknown> });
    return { data: [], usage: { total_tokens: 500 } };
  });
  upstreamUrl = await upstream.listen({ port: 0, host: "127.0.0.1" });
});
afterAll(async () => {
  await upstream.close();
});
beforeEach(() => {
  received.length = 0;
  upstreamStatus = 200;
});

function setup(opts: { limits?: { free: number; paid: number }; rpm?: number } = {}) {
  const store = new ProxyStore(":memory:");
  const user = store.createUser("eve@example.com", "free");
  const { key, prefix } = store.issueKey(user.id);
  const logs: Record<string, unknown>[] = [];
  const app = buildProxyServer({
    store, voyageKey: SERVER_VOYAGE_KEY, voyageBase: `${upstreamUrl}/v1`,
    limits: opts.limits ?? { free: 1_000_000, paid: 10_000_000 }, rpm: opts.rpm ?? 100, log: (l) => logs.push(l),
  });
  const embed = (k: string | undefined, input: string[] = ["hello"], model = "voyage-4") =>
    app.inject({ method: "POST", url: "/v1/voyage/embeddings", headers: k ? { authorization: `Bearer ${k}` } : {}, payload: { model, input, input_type: "document" } });
  return { store, user, key, prefix, app, logs, embed };
}

describe("key proxy", () => {
  it("refuses calls without a live key, and never reaches the vendor", async () => {
    const { embed, store, prefix } = setup();
    expect((await embed(undefined)).statusCode).toBe(401);
    expect((await embed("acgp_not-a-real-key")).statusCode).toBe(401);
    store.revokeKey(prefix);
    expect(received).toHaveLength(0);
  });

  it("forwards on the operator's key, returns the vendor's answer, and meters it", async () => {
    const { embed, key, store, user } = setup();
    const res = await embed(key);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data).toHaveLength(1);
    expect(received[0].auth).toBe(`Bearer ${SERVER_VOYAGE_KEY}`); // never the user's key
    const used = store.monthUsage(user.id);
    expect(used.tokens).toBe(1000);
    expect(used.microUsd).toBe(60); // 1000 tokens x $0.06/M
    expect(res.headers["x-acg-used-usd"]).toBe("0.000060");
  });

  it("stops a revoked key", async () => {
    const { embed, key, store, prefix } = setup();
    expect((await embed(key)).statusCode).toBe(200);
    expect(store.revokeKey(prefix)).toBe(1);
    expect((await embed(key)).statusCode).toBe(401);
  });

  it("scrubs secrets again before they leave, whatever the client sent", async () => {
    const { embed, key } = setup();
    await embed(key, [`deploy with ${SECRET}`]);
    expect(JSON.stringify(received[0].body)).not.toContain(SECRET);
  });

  it("refuses models it has no price for, so the operator's key cannot buy pricier ones", async () => {
    const { embed, key } = setup();
    const res = await embed(key, ["x"], "voyage-3-large");
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe("model_not_allowed");
    expect(received).toHaveLength(0);
  });

  it("enforces the monthly quota before calling the vendor", async () => {
    const { embed, key } = setup({ limits: { free: 50, paid: 1_000_000 } });
    expect((await embed(key)).statusCode).toBe(200); // 60 micro-$ used: now over 50
    const over = await embed(key);
    expect(over.statusCode).toBe(429);
    expect(JSON.parse(over.body).error).toBe("quota_exceeded");
    expect(received).toHaveLength(1);
  });

  it("rate-limits per user per minute", async () => {
    const { embed, key } = setup({ rpm: 2 });
    expect((await embed(key)).statusCode).toBe(200);
    expect((await embed(key)).statusCode).toBe(200);
    const third = await embed(key);
    expect(third.statusCode).toBe(429);
    expect(Number(third.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("passes vendor errors through and does not bill them", async () => {
    const { embed, key, store, user } = setup();
    upstreamStatus = 400;
    const res = await embed(key);
    expect(res.statusCode).toBe(400);
    expect(store.monthUsage(user.id).microUsd).toBe(0);
  });

  it("logs one metadata line per call: never bodies, never keys", async () => {
    const { embed, key, logs } = setup();
    await embed(key, [`the payment webhook ${SECRET}`]);
    await embed(undefined);
    const all = JSON.stringify(logs);
    expect(logs).toHaveLength(2);
    expect(all).not.toContain("payment webhook");
    expect(all).not.toContain(SECRET);
    expect(all).not.toContain(key);
    expect(logs[0]).toMatchObject({ route: "voyage-embeddings", status: 200, tokens: 1000 });
  });

  it("reports a user's own usage and allowance", async () => {
    const { app, embed, key } = setup();
    await embed(key);
    const res = await app.inject({ method: "GET", url: "/v1/usage", headers: { authorization: `Bearer ${key}` } });
    expect(JSON.parse(res.body)).toMatchObject({ plan: "free", usedUsd: 0.00006, limitUsd: 1 });
  });
});

describe("client routing (src/vendors.ts)", () => {
  const saved = { ...process.env };
  const reset = () => {
    for (const k of ["VOYAGE_API_KEY", "TYPESAFE_API_KEY", "JEV_API_KEY", "ACG_PROXY_URL", "ACG_PROXY_KEY"]) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  };
  beforeEach(() => {
    for (const k of ["VOYAGE_API_KEY", "TYPESAFE_API_KEY", "JEV_API_KEY", "ACG_PROXY_URL", "ACG_PROXY_KEY"]) delete process.env[k];
  });
  afterAll(reset);

  it("uses your own key first, the proxy second, and nothing without either", () => {
    expect(vendorTarget("voyage-embeddings").via).toBe("none");
    process.env.ACG_PROXY_URL = "http://proxy.example/";
    process.env.ACG_PROXY_KEY = "acgp_x";
    expect(vendorTarget("voyage-embeddings")).toMatchObject({ via: "proxy", url: "http://proxy.example/v1/voyage/embeddings", key: "acgp_x" });
    expect(vendorTarget("jev")).toMatchObject({ via: "proxy", url: "http://proxy.example/v1/jev" });
    process.env.VOYAGE_API_KEY = "own";
    expect(vendorTarget("voyage-embeddings").via).toBe("own-key");
    expect(vendorTarget("jev").via).toBe("proxy"); // per vendor
  });

  it("end to end: the gateway's embedding client reaches the vendor through a live proxy", async () => {
    const { key, app, store, user } = setup();
    const proxyUrl = await app.listen({ port: 0, host: "127.0.0.1" });
    try {
      process.env.ACG_PROXY_URL = proxyUrl;
      process.env.ACG_PROXY_KEY = key;
      const vecs = await embedDocuments(VOYAGE_GENERAL, ["route me through the proxy"]);
      expect(vecs).toHaveLength(1);
      expect(received[0].auth).toBe(`Bearer ${SERVER_VOYAGE_KEY}`);
      expect(store.monthUsage(user.id).requests).toBe(1);
    } finally {
      await app.close();
    }
  });
});
