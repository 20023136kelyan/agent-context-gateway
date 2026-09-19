/**
 * Validates the committed fixture corpus (Phase 0a).
 *
 * The point of these tests is not that search "works" — it is that the corpus
 * has HEADROOM. An eval corpus where lexical BM25 already answers every query
 * cannot distinguish a lexical arm from a semantic or reranked one, so it
 * cannot tell us whether Jev helps. The paraphrase assertions below are
 * therefore asserting a *deliberate lexical failure*: if they ever start
 * passing lexically, the corpus has lost its ability to measure the thing we
 * built it to measure.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { createApp, closeApp, type GatewayApp } from "../src/app.js";
import { searchOnce, listSessions } from "../src/commands.js";
import { buildFixtureCorpus, FIXTURE_SESSIONS } from "./fixtures/corpus.js";
import type { GoldenQuery } from "../src/eval/runner.js";

let app: GatewayApp;
let prevState: string | undefined;

const golden = JSON.parse(
  readFileSync(join(process.cwd(), "tests", "eval", "golden-fixture.json"), "utf8"),
) as GoldenQuery[];

beforeAll(async () => {
  const root = await mkdtemp(join(tmpdir(), "acg-fixture-"));
  const { claudeDir, codexDir } = await buildFixtureCorpus(root);
  prevState = process.env.CONTEXT_GATEWAY_STATE;
  process.env.CONTEXT_GATEWAY_STATE = join(root, "state");
  app = createApp({ indexDir: join(root, "index"), claudeDir, codexDir });
}, 60_000);

afterAll(() => {
  closeApp(app);
  if (prevState === undefined) delete process.env.CONTEXT_GATEWAY_STATE;
  else process.env.CONTEXT_GATEWAY_STATE = prevState;
});

/** Lexical-only: the floor every other arm has to beat. */
const lexical = (q: string) => searchOnce(app, q, { semantic: false, rerank: false, maxResults: 5 });

describe("fixture corpus", () => {
  it("indexes every session from both harnesses", async () => {
    const sessions = await listSessions(app, {});
    const ids = new Set(sessions.map((s) => s.id));
    for (const s of FIXTURE_SESSIONS) expect(ids.has(s.id)).toBe(true);
    expect(sessions.filter((s) => s.harness === "claude-code").length).toBeGreaterThan(0);
    expect(sessions.filter((s) => s.harness === "codex").length).toBeGreaterThan(0);
  }, 60_000);

  it("every golden query names a session that exists", () => {
    const ids = new Set(FIXTURE_SESSIONS.map((s) => s.id));
    for (const q of golden) {
      expect(q.relevantSessionIds.length).toBeGreaterThan(0);
      for (const sid of q.relevantSessionIds) expect(ids.has(sid)).toBe(true);
    }
  });

  it("covers three domains", () => {
    const byDomain = golden.reduce<Record<string, number>>((a, q) => ((a[q.domain] = (a[q.domain] ?? 0) + 1), a), {});
    expect(Object.keys(byDomain).sort()).toEqual(["code", "paraphrase", "prose"]);
  });

  it("lexical search answers the code-domain queries", async () => {
    // These share vocabulary with their target, so BM25 should find them. If
    // this fails the corpus is broken, not the ranker.
    for (const q of golden.filter((g) => g.domain === "code")) {
      const res = await lexical(q.query);
      const got = new Set(res.results.map((r) => r.provenance.sessionId));
      expect(q.relevantSessionIds.some((id) => got.has(id))).toBe(true);
    }
  }, 60_000);

  it("leaves paraphrase headroom that lexical search cannot reach", async () => {
    // The measurable gap Jev and embeddings exist to close. At least half the
    // paraphrase queries must MISS lexically, or the corpus cannot separate arms.
    const missed: string[] = [];
    for (const q of golden.filter((g) => g.domain === "paraphrase")) {
      const res = await lexical(q.query);
      const got = new Set(res.results.map((r) => r.provenance.sessionId));
      if (!q.relevantSessionIds.some((id) => got.has(id))) missed.push(q.id);
    }
    const paraphraseCount = golden.filter((g) => g.domain === "paraphrase").length;
    expect(missed.length).toBeGreaterThanOrEqual(Math.ceil(paraphraseCount / 2));
  }, 60_000);

  it("contains distractors that outrank the answer lexically", async () => {
    // Session 010 restates every decision topic without concluding anything.
    // A lexical arm should be seduced by it on at least one decision query —
    // that is the precision failure a reranker has to fix.
    const decisionQueries = golden.filter((g) => g.domain === "prose");
    let seduced = 0;
    for (const q of decisionQueries) {
      const res = await lexical(q.query);
      const top = res.results[0]?.provenance.sessionId;
      if (top && !q.relevantSessionIds.includes(top)) seduced += 1;
    }
    expect(seduced).toBeGreaterThan(0);
  }, 60_000);
});
