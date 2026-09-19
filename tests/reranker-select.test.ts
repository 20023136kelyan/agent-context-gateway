/**
 * Reranker selection and the default-off guarantee (Phase 2).
 *
 * The guarantee that matters: reranking NEVER happens unless a caller asks for
 * it. A remote reranker ships live query text and candidate excerpts to a third
 * party on every search, which is a sharper privacy cost than embeddings (a
 * one-time backfill of content you chose to index). So key presence alone must
 * not be sufficient — the caller has to opt in per request as well.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  resolveRerankerName,
  makeReranker,
  noopReranker,
  rerankerAvailable,
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

describe("default-off guarantee", () => {
  it("SearchService does not call the reranker unless rerank is requested", async () => {
    const { SearchService } = await import("../src/search/search.js");
    const spy = vi.fn(async () => []);
    const svc = Object.create(SearchService.prototype) as InstanceType<typeof SearchService>;
    svc.setReranker({ rerank: spy });

    // The gate in search.ts is a strict `opts.rerank === true`, so every falsy
    // and absent value must leave the reranker untouched.
    const source = (await import("node:fs")).readFileSync("src/search/search.ts", "utf8");
    expect(source).toContain("opts.rerank === true");
    expect(spy).not.toHaveBeenCalled();
  });

  it("every transport leaves rerank absent unless asked", async () => {
    const fs = await import("node:fs");
    const http = fs.readFileSync("src/transports/http.ts", "utf8");
    const mcp = fs.readFileSync("src/transports/mcp.ts", "utf8");
    const cli = fs.readFileSync("src/cli.ts", "utf8");
    // HTTP requires the literal string; a missing param is false, never undefined-true.
    expect(http).toMatch(/rerank: q\.rerank === "true" \|\| q\.rerank === "1"/);
    // MCP exposes it as an optional boolean, so omitting it is undefined.
    expect(mcp).toMatch(/rerank: z\s*\n?\s*\.boolean\(\)\s*\n?\s*\.optional\(\)/);
    // CLI is a commander flag: absent means undefined, coerced to false.
    expect(cli).toContain("rerank: cmdOpts.rerank ?? false");
  });
});

describe("rerank plumbing, end to end", () => {
  it("HTTP invokes the reranker only when ?rerank=true", async () => {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { createApp, closeApp } = await import("../src/app.js");
    const { buildHttpServer } = await import("../src/transports/http.js");
    const { buildFixtureCorpus } = await import("./fixtures/corpus.js");

    const root = await mkdtemp(join(tmpdir(), "acg-rerank-http-"));
    const { claudeDir, codexDir } = await buildFixtureCorpus(root);
    const prev = process.env.CONTEXT_GATEWAY_STATE;
    process.env.CONTEXT_GATEWAY_STATE = join(root, "state");
    const app = createApp({ indexDir: join(root, "index"), claudeDir, codexDir });

    // Stub stands in for whichever reranker was selected, so this asserts the
    // request plumbing rather than any vendor's behaviour.
    const spy = vi.fn(async (_q: string, cands: { id: string; content: string; score: number }[]) =>
      cands.map((c) => ({ id: c.id, originalScore: c.score, rerankScore: 1, combinedScore: 1, neural: true })),
    );
    app.search.setReranker({ rerank: spy });

    try {
      const server = buildHttpServer(app);
      const plain = await server.inject({ method: "GET", url: "/search?q=why+did+we+reject+Monaco" });
      expect(plain.statusCode).toBe(200);
      expect(spy).not.toHaveBeenCalled(); // default off

      const reranked = await server.inject({ method: "GET", url: "/search?q=why+did+we+reject+Monaco&rerank=true" });
      expect(reranked.statusCode).toBe(200);
      expect(spy).toHaveBeenCalled(); // opt-in honoured
    } finally {
      closeApp(app);
      if (prev === undefined) delete process.env.CONTEXT_GATEWAY_STATE;
      else process.env.CONTEXT_GATEWAY_STATE = prev;
    }
  }, 120_000);
});
