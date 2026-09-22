/**
 * Secret scrubbing (src/security/scrub.ts): what leaves the machine.
 *
 * Fake credentials are assembled at runtime. Written out whole they would sit
 * in the repo as key-shaped strings, which GitHub push protection rejects and
 * which this very scrubber would then find in our own agent histories.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { scrubText, scrubDeep, scrubMeter } from "../src/security/scrub.js";
import { embedDocuments, VOYAGE_GENERAL } from "../src/embeddings/voyage.js";
import { httpJevClient } from "../src/judgments/jev.js";
import { JevReranker } from "../src/judgments/rerank-jev.js";
import { VoyageReranker } from "../src/search/rerank-voyage.js";
import { embedSessionTurns } from "../src/indexing/embed-sync.js";
import { RERANK_CONTENT_CHARS } from "../src/search/reranker.js";
import type { ContextAdapter } from "../src/adapters/types.js";
import type { VectorBackend } from "../src/indexing/vectors.js";
import type { Session, Turn } from "../src/core/models.js";

const rep = (c: string, n: number) => c.repeat(n);
const FAKE = {
  github: "gh" + "p_" + rep("a1B2", 9),
  githubPat: "github" + "_pat_" + rep("x9", 20),
  openai: "sk" + "-proj-" + rep("Ab3", 10),
  anthropic: "sk" + "-ant-api03-" + rep("Zz9", 8),
  aws: "AK" + "IA" + rep("Q7", 8),
  slack: "xo" + "xb-" + rep("12345-", 3),
  stripe: "sk" + "_live_" + rep("9aZ", 8),
  google: "AI" + "za" + rep("Sy1", 11) + "xy",
  jwt: "ey" + "J" + rep("hbGc", 4) + ".ey" + "J" + rep("zdWI", 4) + "." + rep("SflK", 4),
  voyage: "pa" + "-" + rep("k3Y", 12),
};
const PEM_BODY = rep("MIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n", 8);
const PEM = `-----BEGIN PRIVATE KEY-----\n${PEM_BODY}-----END PRIVATE KEY-----`;

beforeEach(() => {
  delete process.env.GATEWAY_SCRUB;
  scrubMeter.reset();
});

describe("scrubText: secrets", () => {
  it.each(Object.entries(FAKE))("redacts a bare %s", (_kind, secret) => {
    const out = scrubText(`here it is: ${secret} (do not share)`);
    expect(out).not.toContain(secret);
    expect(out).toMatch(/<REDACTED:[a-z_]+>/);
    expect(out).toContain("(do not share)");
  });

  it("labels the Anthropic key as Anthropic, not OpenAI", () => {
    expect(scrubText(FAKE.anthropic)).toBe("<REDACTED:anthropic_key>");
  });

  it("redacts a full private key block", () => {
    const out = scrubText(`key:\n${PEM}\nthen we deployed`);
    expect(out).not.toContain("MIIEvQIBADANBgkqhkiG9w0");
    expect(out).toContain("then we deployed");
  });

  it("redacts an unterminated private key through to the end of the text", () => {
    const cut = `-----BEGIN RSA PRIVATE KEY-----\n${PEM_BODY}`;
    expect(scrubText(`look: ${cut}`)).toBe("look: <REDACTED:private_key>");
  });

  it("redacts the key body before an orphaned END marker", () => {
    const out = scrubText(`${PEM_BODY}-----END PRIVATE KEY-----\nrest`);
    expect(out).toBe("<REDACTED:private_key>\nrest");
  });

  it("keeps the auth scheme and the URL, dropping only the credential", () => {
    expect(scrubText(`Authorization: Bearer ${rep("tok3n", 6)}`)).toBe("Authorization: Bearer <REDACTED:bearer>");
    expect(scrubText("postgres://admin:hunter2pass@db.internal:5432/app")).toBe(
      "postgres://admin:<REDACTED:url_credential>@db.internal:5432/app",
    );
  });

  it("redacts named credentials in env, JSON and YAML shapes", () => {
    expect(scrubText("DB_PASSWORD=Xk29fjq83LmPq")).toBe("DB_PASSWORD=<REDACTED:credential>");
    expect(scrubText('{"api_key": "abcd1234efgh"}')).toBe('{"api_key": "<REDACTED:credential>"}');
    expect(scrubText("client_secret: 7f3a9b2c8d1e6f40")).toBe("client_secret: <REDACTED:credential>");
  });
});

describe("scrubText: what it must leave alone", () => {
  it.each([
    ["a git SHA", "fixed in 15f4d62e6a4ac50274f44cac2e2dfcdadad38f38"],
    ["a UUID session id", "session 01a093f3-8ffe-7923-ac2c-dd806823f2f4"],
    ["a file path", "see src/security/scrub.ts:42"],
    ["a type annotation", "function f(token: string, password: string)"],
    ["a computed value", "const password = hashPassword(input)"],
    ["an env reference", "const apiKey = process.env.TYPESAFE_API_KEY"],
    ["a shell reference", "curl -H \"x-api-key: ${VOYAGE_API_KEY}\""],
    ["loopback and wildcard addresses", "bind 127.0.0.1:3000 or 0.0.0.0"],
    ["a 4-part version that is not an address", "upgrade to 10.300.1.2"],
    ["prose", "a basic understanding of the tokenizer is enough"],
  ])("leaves %s intact", (_label, text) => {
    expect(scrubText(text)).toBe(text);
  });
});

describe("scrubText: PII and modes", () => {
  it("redacts emails and non-loopback IPv4 by default", () => {
    expect(scrubText("mail ops@example.com about 10.2.3.4")).toBe("mail <REDACTED:email> about <REDACTED:ipv4>");
  });

  it("keeps PII but still redacts secrets in `secrets` mode", () => {
    process.env.GATEWAY_SCRUB = "secrets";
    expect(scrubText(`ops@example.com ${FAKE.github}`)).toBe("ops@example.com <REDACTED:github_token>");
  });

  it("returns text verbatim in `off` mode", () => {
    process.env.GATEWAY_SCRUB = "off";
    const text = `ops@example.com ${FAKE.github}`;
    expect(scrubText(text)).toBe(text);
  });

  it("is idempotent and does not recount what it already redacted", () => {
    const once = scrubText(`${FAKE.github} ${FAKE.jwt} DB_PASSWORD="Xk29fjq83LmPq"`);
    const counted = scrubMeter.snapshot();
    expect(scrubText(once)).toBe(once);
    expect(scrubMeter.snapshot()).toEqual(counted);
    expect(counted).toEqual({ github_token: 1, jwt: 1, credential: 1 });
  });
});

describe("scrubDeep", () => {
  it("scrubs nested string values, keeps keys, and never mutates the input", () => {
    const state = { query: "why did we rotate it", candidates: [`token ${FAKE.github}`], meta: { n: 3 } };
    const copy = structuredClone(state);
    const out = scrubDeep(state);
    expect(out.candidates[0]).toBe("token <REDACTED:github_token>");
    expect(out.meta).toEqual({ n: 3 });
    expect(Object.keys(out)).toEqual(["query", "candidates", "meta"]);
    expect(state).toEqual(copy);
  });
});

/** Every vendor request goes through a stubbed fetch; its bodies are captured. */
describe("egress: nothing secret reaches a vendor", () => {
  const realFetch = globalThis.fetch;
  const saved = { voyage: process.env.VOYAGE_API_KEY, jev: process.env.TYPESAFE_API_KEY };
  let bodies: string[];

  beforeEach(() => {
    bodies = [];
    process.env.VOYAGE_API_KEY = "k";
    process.env.TYPESAFE_API_KEY = "k";
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.unstubAllGlobals();
    for (const [name, v] of [["VOYAGE_API_KEY", saved.voyage], ["TYPESAFE_API_KEY", saved.jev]] as const) {
      if (v === undefined) delete process.env[name];
      else process.env[name] = v;
    }
  });

  /** Voyage embeddings answer with one vector per input; others with an empty 200. */
  const capture = (respond: (body: any) => unknown) =>
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(String(init.body));
        return new Response(JSON.stringify(respond(JSON.parse(String(init.body)))), { status: 200 });
      }),
    );
  const voyageEmbeddings = (b: any) => ({
    data: (b.input as string[]).map((_: string, index: number) => ({ index, embedding: new Array(VOYAGE_GENERAL.dim).fill(0) })),
  });
  const secretsIn = (s: string) => Object.values(FAKE).filter((v) => s.includes(v)).concat(s.includes("MIIEvQIBADANBgkqhkiG9w0") ? ["pem"] : []);

  it("Voyage embeddings", async () => {
    capture(voyageEmbeddings);
    await embedDocuments(VOYAGE_GENERAL, [`set ${FAKE.openai}`, `also ${FAKE.aws}`]);
    expect(secretsIn(bodies.join())).toEqual([]);
  });

  it("every Jev request, whatever the caller puts in state", async () => {
    capture(() => ({ answers: {} }));
    await httpJevClient.noul({ query: `why ${FAKE.slack}`, deep: { list: [FAKE.stripe] } }, { q: { instructions: "?" } });
    expect(secretsIn(bodies.join())).toEqual([]);
  });

  /** A token that starts 10 chars before the cut: the kept part is too short
   *  for any pattern, so only scrubbing BEFORE truncation stops the prefix. */
  const straddling = (pad: string) =>
    rep(pad, RERANK_CONTENT_CHARS - 11) + " " + FAKE.github + " and more text after the cut";
  const githubPrefix = FAKE.github.slice(0, 8);

  it("the Jev reranker scrubs before truncating, so a token cut at the limit cannot leak", async () => {
    capture(() => ({ answers: {} }));
    await new JevReranker().rerank("which token", [
      { id: "a", content: straddling("x"), score: 1 },
      { id: "b", content: "fine", score: 0.5 },
    ]);
    expect(bodies.length).toBeGreaterThan(0);
    expect(bodies.join()).not.toContain(githubPrefix);
  });

  it("the Voyage reranker scrubs the query, and the documents before truncating", async () => {
    capture(() => ({ data: [] }));
    await new VoyageReranker().rerank(`rotate ${FAKE.google}`, [{ id: "a", content: straddling("y"), score: 1 }]);
    expect(secretsIn(bodies.join())).toEqual([]);
    expect(bodies.join()).not.toContain(githubPrefix);
  });

  it("embedding backfill scrubs whole turns before chunking them", async () => {
    capture(voyageEmbeddings);
    // An RSA-4096 key runs ~3200 chars, longer than one embedding window, so
    // some chunk holds only base64 with neither BEGIN nor END to recognise.
    const longKey = `-----BEGIN RSA PRIVATE KEY-----\n${rep("MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7\n", 64)}-----END RSA PRIVATE KEY-----`;
    const content = "deploy notes\n" + longKey + "\nafter";
    const turn = { id: "claude-code:s1:t1", sessionId: "s1", harness: "claude-code", seq: 0, role: "assistant", timestamp: "2026-09-23T00:00:00Z", content } as Turn;
    const session = { id: "s1", harness: "claude-code", agentId: "a", projectId: "p", sourcePath: "/x" } as Session;
    const adapter = { harness: "claude-code", listTurns: async () => [turn] } as unknown as ContextAdapter;
    const store = {
      existing: async () => new Set<string>(),
      upsert: async () => undefined,
      maybeOptimize: async () => undefined,
    } as unknown as VectorBackend;
    await embedSessionTurns(adapter, session, store, 64, "voyage");
    expect(bodies.length).toBeGreaterThan(0);
    expect(secretsIn(bodies.join())).toEqual([]);
  });
});
