#!/usr/bin/env node
/**
 * LLM sufficiency scoring (needs `opencode auth login` once, interactive).
 *
 * For each golden query: retrieves top-5 contexts with the given arm, asks
 * muse-spark (free contributor tier) to grade whether the retrieved evidence
 * suffices to answer, and records 0/1/2 + rationale as JSONL. This is the
 * ALCE-style human-proxy metric beside NDCG: ranking quality vs answerability.
 *
 * Usage: node scripts/score-contexts.mjs --corpus fixture --arm hybrid [--golden ...] [--out sweeps/scores.jsonl] [--limit 5]
 * Requires: opencode on PATH, authed, model opencode/muse-spark-1.3-contributor-free.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, appendFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const arg = (f, d) => {
  const i = process.argv.indexOf(f);
  return i >= 0 ? process.argv[i + 1] : d;
};
const MODEL = process.env.SCORE_MODEL ?? "opencode/muse-spark-1.3-contributor-free";

const GOLDENS = {
  fixture: "tests/eval/golden-fixture.json",
  trajectories: "tests/eval/golden-trajectories.json",
  real: "swe-data/golden-real.json",
};

async function main() {
  const [{ createApp, closeApp, initVectors }] = [await import("../src/app.js")];
  const { searchOnce, backfillEmbeddings } = await import("../src/commands.js");
  const corpus = arg("--corpus", "fixture");
  const arm = arg("--arm", "hybrid");
  const goldenPath = arg("--golden", GOLDENS[corpus] ?? GOLDENS.fixture);
  const out = arg("--out", "sweeps/scores.jsonl");
  const limit = Number(arg("--limit", "0")) || Infinity;
  mkdirSync(dirname(out), { recursive: true });

  const root = mkdtempSync(join(tmpdir(), "acg-score-"));
  process.env.CONTEXT_GATEWAY_STATE = join(root, "state");
  let appOpts = { indexDir: join(root, "index") };
  if (corpus === "fixture") {
    const { buildFixtureCorpus } = await import("../tests/fixtures/corpus.js");
    Object.assign(appOpts, await buildFixtureCorpus(root).then(({ claudeDir, codexDir }) => ({ claudeDir, codexDir })));
  } else {
    throw new Error("score-contexts currently supports --corpus fixture only");
  }
  const app = createApp(appOpts);
  try {
    await initVectors(app).catch(() => {});
    await backfillEmbeddings(app, {}).catch(() => {});
    // No auth preflight: `opencode run` works keyless (contributor tier);
    // a real auth failure surfaces per query below as SCORE: -1.
    const semantic = arm !== "lexical";
    const queries = JSON.parse(readFileSync(goldenPath, "utf8")).slice(0, limit);
    for (const q of queries) {
      const res = await searchOnce(app, q.query, { maxResults: 5, semantic, rerank: arm !== "lexical" });
      const evidence = res.results
        .map((h, i) => `[${i + 1}] ${h.provenance.harness}:${h.provenance.sessionId} turn ${h.provenance.turnId}\n${h.summary}\n${h.context.map((t) => t.content.slice(0, 400)).join("\n---\n").slice(0, 1200)}`)
        .join("\n\n");
      const prompt = `Question: ${q.query}\n\nRetrieved evidence (5 passages with provenance):\n${evidence}\n\nGrade ONLY the evidence: 2 = fully answers, 1 = partially answers, 0 = does not answer. End your reply with exactly: SCORE: N`;
      let raw = "";
      try {
        // Isolated XDG home: every `opencode run` appends a session to its
        // store, and those sessions quote the golden queries verbatim — which
        // once polluted every subsequent fixture eval (judge Hit@1 0.952 zone
        // -> 0.381 with zero code change). Scoring must not write scorable
        // histories anywhere near an eval corpus.
        const xdg = mkdtempSync(join(tmpdir(), "acg-score-xdg-"));
        raw = execFileSync("opencode", ["run", "--model", MODEL, prompt], {
          encoding: "utf8",
          timeout: 300000,
          maxBuffer: 64 * 1024,
          env: { ...process.env, XDG_DATA_HOME: xdg },
        });
      } catch (e) {
        raw = `ERROR ${String(e.message ?? e).slice(0, 200)} SCORE: -1`;
      }
      const m = raw.match(/SCORE:\s*(-?\d)/);
      const row = { query: q.id, arm, model: MODEL, score: m ? Number(m[1]) : null, raw: raw.slice(-800) };
      appendFileSync(out, JSON.stringify(row) + "\n");
      console.log(q.id, "score=" + row.score);
    }
  } finally {
    closeApp(app);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
