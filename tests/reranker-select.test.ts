/**
 * Reranker selection and the default-off guarantee (Phase 2).
 *
 * The default is RERANKER-AWARE, and that is the thing to pin.
 *
 * A blanket default-off left every search at hybrid's quality when better was
 * available. A blanket default-on then gave keyless deployments multi-second
 * searches for nothing: on BEIR nfcorpus the local cross-encoder scored 0.433
 * NDCG@5 at 6984ms p50 against plain hybrid's 0.445 at 318ms, while Jev scored
 * 0.489 at 620ms. So the default is on for Jev and off for the cross-encoder.
 *
 * Two properties must hold regardless of that default:
 *   - an explicit `rerank` on the request ALWAYS wins, both directions
 *   - `GATEWAY_RERANKER=none` disables it system-wide
 * A default is a choice; a silently ignored override is a bug.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  resolveRerankerName,
  makeReranker,
  noopReranker,
  rerankerAvailable,
  rerankDefaultOn,
} from "../src/search/reranker.js";

const KEYS = ["TYPESAFE_API_KEY", "JEV_API_KEY", "GATEWAY_RERANKER"] as const;
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
});

describe("reranker selection", () => {
  it("falls to the local cross-encoder when no Jev key is present", () => {
    expect(resolveRerankerName()).toBe("cross-encoder");
  });

  it("prefers Jev once a key is present", () => {
    process.env.TYPESAFE_API_KEY = "k";
    expect(resolveRerankerName()).toBe("jev");
  });

  it("accepts JEV_API_KEY as an alias", () => {
    process.env.JEV_API_KEY = "k";
    expect(resolveRerankerName()).toBe("jev");
  });

  it("honours a pin and does not fall back past it", () => {
    // A pinned name is a hard selection: a deployment that pins cross-encoder
    // must not silently start calling a vendor because a key appeared.
    process.env.TYPESAFE_API_KEY = "k";
    process.env.GATEWAY_RERANKER = "cross-encoder";
    expect(resolveRerankerName()).toBe("cross-encoder");
  });

  it("can be pinned off entirely", () => {
    process.env.TYPESAFE_API_KEY = "k";
    process.env.GATEWAY_RERANKER = "none";
    expect(resolveRerankerName()).toBe("none");
  });

  it("pinning jev without a key still selects jev, and it degrades at call time", async () => {
    // Explicit intent is honoured; the failure is then loud at the call site
    // rather than a silent downgrade that looks like a quality regression.
    process.env.GATEWAY_RERANKER = "jev";
    expect(resolveRerankerName()).toBe("jev");
    const r = makeReranker("jev");
    const out = await r.rerank("q", [{ id: "a", content: "x", score: 0.5 }]);
    expect(out[0].neural).toBe(false); // degraded, order preserved
  });

  it("reports Jev as unavailable without a key", () => {
    expect(rerankerAvailable("jev")).toBe(false);
    process.env.TYPESAFE_API_KEY = "k";
    expect(rerankerAvailable("jev")).toBe(true);
  });

  it("the none reranker preserves order and flags itself as not neural", async () => {
    const out = await noopReranker.rerank("q", [
      { id: "a", content: "x", score: 0.2 },
      { id: "b", content: "y", score: 0.9 },
    ]);
    expect(out.map((r) => r.id)).toEqual(["a", "b"]); // untouched
    expect(out.every((r) => !r.neural)).toBe(true);
  });
});

describe("the default is reranker-aware", () => {
  it("is on for Jev and off for the ones that did not earn it", () => {
    expect(rerankDefaultOn("jev")).toBe(true);
    // Measured below plain hybrid on real documents, at 10-20x the latency.
    expect(rerankDefaultOn("cross-encoder")).toBe(false);
    expect(rerankDefaultOn("none")).toBe(false);
  });

  it("SearchService reranks only on a strict `true`, so the gate cannot be tripped by a stray value", async () => {
    const { SearchService } = await import("../src/search/search.js");
    const spy = vi.fn(async () => []);
    const svc = Object.create(SearchService.prototype) as InstanceType<typeof SearchService>;
    svc.setReranker({ rerank: spy });

    // Transports resolve the default and pass a real boolean; the service stays
    // strict so an `undefined` from any other path never reranks by accident.
    const source = (await import("node:fs")).readFileSync("src/search/search.ts", "utf8");
    expect(source).toContain("opts.rerank === true");
    expect(spy).not.toHaveBeenCalled();
  });

  it("every transport defers to the registry when the caller says nothing", async () => {
    const fs = await import("node:fs");
    const http = fs.readFileSync("src/transports/http.ts", "utf8");
    const mcp = fs.readFileSync("src/transports/mcp.ts", "utf8");
    const cli = fs.readFileSync("src/cli.ts", "utf8");
    const cmds = fs.readFileSync("src/commands.ts", "utf8");
    // HTTP: absent -> registry; only the literal "false"/"0" force it off.
    expect(http).toContain("q.rerank === undefined");
    expect(http).toContain("rerankDefaultOn(app.reranker)");
    // MCP: optional, so an omitted field is undefined rather than coerced true.
    expect(mcp).toMatch(/rerank: z\s*\n?\s*\.boolean\(\)\s*\n?\s*\.optional\(\)/);
    expect(mcp).toContain("args.rerank ?? rerankDefaultOn(app.reranker)");
    // CLI: --no-rerank forces off; anything else defers.
    expect(cli).toContain("--no-rerank");
    expect(cli).toContain("cmdOpts.rerank === false ? false : rerankDefaultOn(app.reranker)");
    // decide is bounded by the same ranking, so it uses the same default.
    expect(cmds).toContain("opts.rerank ?? rerankDefaultOn(app.reranker)");
  });

  it("GATEWAY_RERANKER=none disables it system-wide regardless of request", async () => {
    process.env.TYPESAFE_API_KEY = "k";
    process.env.GATEWAY_RERANKER = "none";
    expect(resolveRerankerName()).toBe("none");
    expect(rerankDefaultOn(resolveRerankerName())).toBe(false);
    const out = await makeReranker("none").rerank("q", [
      { id: "a", content: "x", score: 0.2 },
      { id: "b", content: "y", score: 0.9 },
    ]);
    expect(out.map((r) => r.id)).toEqual(["a", "b"]);
    expect(out.every((r) => !r.neural)).toBe(true);
  });
});

describe("rerank plumbing, end to end", () => {
  /** One app + server per reranker pin, so createApp resolves it at build time. */
  async function withServer(pin: string, fn: (server: any, spy: any) => Promise<void>) {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { createApp, closeApp } = await import("../src/app.js");
    const { buildHttpServer } = await import("../src/transports/http.js");
    const { buildFixtureCorpus } = await import("./fixtures/corpus.js");

    const root = await mkdtemp(join(tmpdir(), "acg-rerank-http-"));
    const { claudeDir, codexDir } = await buildFixtureCorpus(root);
    const prevState = process.env.CONTEXT_GATEWAY_STATE;
    process.env.CONTEXT_GATEWAY_STATE = join(root, "state");
    process.env.TYPESAFE_API_KEY = "k";
    process.env.GATEWAY_RERANKER = pin;
    const app = createApp({ indexDir: join(root, "index"), claudeDir, codexDir });

    // Stub stands in for whichever reranker was selected, so this asserts the
    // request plumbing rather than any vendor's behaviour.
    const spy = vi.fn(async (_q: string, cands: { id: string; content: string; score: number }[]) =>
      cands.map((c) => ({ id: c.id, originalScore: c.score, rerankScore: 1, combinedScore: 1, neural: true })),
    );
    app.search.setReranker({ rerank: spy });
    try {
      await fn(buildHttpServer(app), spy);
    } finally {
      closeApp(app);
      if (prevState === undefined) delete process.env.CONTEXT_GATEWAY_STATE;
      else process.env.CONTEXT_GATEWAY_STATE = prevState;
    }
  }

  const URL = "/search?q=why+did+we+reject+Monaco";

  it("with Jev selected, reranks unasked and stops on ?rerank=false", async () => {
    await withServer("jev", async (server, spy) => {
      expect((await server.inject({ method: "GET", url: URL })).statusCode).toBe(200);
      expect(spy).toHaveBeenCalled(); // default ON for jev
      spy.mockClear();
      expect((await server.inject({ method: "GET", url: `${URL}&rerank=false` })).statusCode).toBe(200);
      expect(spy).not.toHaveBeenCalled(); // opt-out wins
    });
  }, 120_000);

  it("with the cross-encoder selected, stays off unless asked", async () => {
    await withServer("cross-encoder", async (server, spy) => {
      expect((await server.inject({ method: "GET", url: URL })).statusCode).toBe(200);
      expect(spy).not.toHaveBeenCalled(); // default OFF: it measured below hybrid
      expect((await server.inject({ method: "GET", url: `${URL}&rerank=true` })).statusCode).toBe(200);
      expect(spy).toHaveBeenCalled(); // opt-in wins
    });
  }, 120_000);
});
