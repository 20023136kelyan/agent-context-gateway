/**
 * Reranker selection and the default-off guarantee (Phase 2).
 *
 * The default is OFF UNLESS CHOSEN, and that is the thing to pin.
 *
 * Jev earned default-on from BEIR (0.445 -> 0.489 NDCG@5), then lost it on
 * real agent history: judged, no reranker lifted plain hybrid beyond noise
 * and Jev put a worse session first more often than a better one (README,
 * "Reranker bake-off"). So a vendor key alone does not rerank. It runs by
 * default when the user chose a reranker, or hosts one; rerankByDefault
 * (GATEWAY_RERANK_DEFAULT, `acg config set rerank-default`) overrides both.
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

const KEYS = ["TYPESAFE_API_KEY", "JEV_API_KEY", "GATEWAY_RERANKER", "GATEWAY_RERANK_DEFAULT", "GATEWAY_RERANK_URL"] as const;
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
  it("falls to none when no vendor key is present", () => {
    expect(resolveRerankerName()).toBe("none");
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
    // A pinned name is a hard selection: a deployment that pins voyage must
    // not silently switch vendors because another key appeared.
    process.env.TYPESAFE_API_KEY = "k";
    process.env.GATEWAY_RERANKER = "voyage";
    expect(resolveRerankerName()).toBe("voyage");
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

describe("the default is off unless chosen", () => {
  const auto = { reranker: null, rerankByDefault: null };
  it("a key alone does not rerank; choosing a reranker or hosting one does", () => {
    expect(rerankDefaultOn("jev", auto)).toBe(false);
    expect(rerankDefaultOn("voyage", auto)).toBe(false);
    expect(rerankDefaultOn("none", auto)).toBe(false);
    expect(rerankDefaultOn("self-hosted", auto)).toBe(true);
    expect(rerankDefaultOn("jev", { reranker: "jev", rerankByDefault: null })).toBe(true);
    expect(rerankDefaultOn("voyage", { reranker: "voyage", rerankByDefault: null })).toBe(true);
  });

  it("rerankByDefault overrides either way, and none never reranks", () => {
    expect(rerankDefaultOn("jev", { reranker: "jev", rerankByDefault: false })).toBe(false);
    expect(rerankDefaultOn("self-hosted", { reranker: null, rerankByDefault: false })).toBe(false);
    expect(rerankDefaultOn("jev", { reranker: null, rerankByDefault: true })).toBe(true);
    expect(rerankDefaultOn("none", { reranker: "none", rerankByDefault: true })).toBe(false);
  });

  it("a hosted endpoint is picked first when reranking is asked for", () => {
    process.env.TYPESAFE_API_KEY = "k";
    process.env.GATEWAY_RERANK_URL = "http://127.0.0.1:1/v1/rerank";
    expect(resolveRerankerName()).toBe("self-hosted");
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

  it("every transport defers to the gateway's default when the caller says nothing", async () => {
    const fs = await import("node:fs");
    const http = fs.readFileSync("src/transports/http.ts", "utf8");
    const mcp = fs.readFileSync("src/transports/mcp.ts", "utf8");
    const cli = fs.readFileSync("src/cli.ts", "utf8");
    const cmds = fs.readFileSync("src/commands.ts", "utf8");
    // HTTP: absent -> registry; only the literal "false"/"0" force it off.
    expect(http).toContain("q.rerank === undefined");
    expect(http).toContain("? app.rerankByDefault");
    // MCP: optional, so an omitted field is undefined rather than coerced true.
    expect(mcp).toMatch(/rerank: z\s*\n?\s*\.boolean\(\)\s*\n?\s*\.optional\(\)/);
    expect(mcp).toContain("args.rerank ?? app.rerankByDefault");
    // CLI: --no-rerank forces off; anything else defers.
    expect(cli).toContain("--no-rerank");
    expect(cli).toContain("rerank: cmdOpts.rerank ?? app.rerankByDefault");
    // decide is bounded by the same ranking, so it uses the same default.
    expect(cmds).toContain("opts.rerank ?? app.rerankByDefault");
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
  async function withServer(pin: string, fn: (server: any, spy: any) => Promise<void>, rerankDefault?: string) {
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
    if (pin) process.env.GATEWAY_RERANKER = pin;
    if (rerankDefault) process.env.GATEWAY_RERANK_DEFAULT = rerankDefault;
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

  it("with a key and nothing chosen, stays off unless asked", async () => {
    await withServer("", async (server, spy) => {
      expect((await server.inject({ method: "GET", url: URL })).statusCode).toBe(200);
      expect(spy).not.toHaveBeenCalled(); // a key alone does not rerank
      expect((await server.inject({ method: "GET", url: `${URL}&rerank=true` })).statusCode).toBe(200);
      expect(spy).toHaveBeenCalled(); // opt-in wins
    });
  }, 120_000);

  it("with Jev chosen, reranks unasked and stops on ?rerank=false", async () => {
    await withServer("jev", async (server, spy) => {
      expect((await server.inject({ method: "GET", url: URL })).statusCode).toBe(200);
      expect(spy).toHaveBeenCalled(); // the user chose it
      spy.mockClear();
      expect((await server.inject({ method: "GET", url: `${URL}&rerank=false` })).statusCode).toBe(200);
      expect(spy).not.toHaveBeenCalled(); // opt-out wins
    });
  }, 120_000);

  it("with voyage chosen but rerank-default off, stays off unless asked", async () => {
    await withServer("voyage", async (server, spy) => {
      expect((await server.inject({ method: "GET", url: URL })).statusCode).toBe(200);
      expect(spy).not.toHaveBeenCalled(); // rerank-default off wins over the choice
      expect((await server.inject({ method: "GET", url: `${URL}&rerank=true` })).statusCode).toBe(200);
      expect(spy).toHaveBeenCalled(); // opt-in wins
    }, "off");
  }, 120_000);
});
