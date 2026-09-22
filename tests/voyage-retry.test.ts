/**
 * Voyage embedding retries. One slow response used to kill a 46k-chunk
 * backfill (AbortError, no retry); these pin which failures retry and which
 * must still fail at once.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { embedDocuments, VOYAGE_GENERAL } from "../src/embeddings/voyage.js";

const saved = { key: process.env.VOYAGE_API_KEY, backoff: process.env.VOYAGE_BACKOFF_MS };
const vectors = (n: number) =>
  new Response(
    JSON.stringify({ data: Array.from({ length: n }, (_, index) => ({ index, embedding: new Array(VOYAGE_GENERAL.dim).fill(0) })) }),
    { status: 200 },
  );
const abortError = () => Object.assign(new Error("This operation was aborted"), { name: "AbortError" });

beforeEach(() => {
  process.env.VOYAGE_API_KEY = "k";
  process.env.VOYAGE_BACKOFF_MS = "0";
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const [name, v] of [["VOYAGE_API_KEY", saved.key], ["VOYAGE_BACKOFF_MS", saved.backoff]] as const) {
    if (v === undefined) delete process.env[name];
    else process.env[name] = v;
  }
});

describe("Voyage embedding retries", () => {
  it("retries a timeout and succeeds", async () => {
    const fetch = vi.fn().mockRejectedValueOnce(abortError()).mockResolvedValueOnce(vectors(2));
    vi.stubGlobal("fetch", fetch);
    await expect(embedDocuments(VOYAGE_GENERAL, ["a", "b"])).resolves.toHaveLength(2);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("retries 429 and 5xx", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("slow down", { status: 429, headers: { "retry-after": "0" } }))
      .mockResolvedValueOnce(new Response("oops", { status: 503 }))
      .mockResolvedValueOnce(vectors(1));
    vi.stubGlobal("fetch", fetch);
    await expect(embedDocuments(VOYAGE_GENERAL, ["a"])).resolves.toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("fails at once on a 400: retrying a bad request changes nothing", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("bad input", { status: 400 }));
    vi.stubGlobal("fetch", fetch);
    await expect(embedDocuments(VOYAGE_GENERAL, ["a"])).rejects.toThrow(/voyage-http-400/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("gives up after the attempt budget and surfaces the last error", async () => {
    const fetch = vi.fn().mockRejectedValue(abortError());
    vi.stubGlobal("fetch", fetch);
    await expect(embedDocuments(VOYAGE_GENERAL, ["a"])).rejects.toThrow(/aborted/);
    expect(fetch).toHaveBeenCalledTimes(4);
  });
});
