#!/usr/bin/env node
/**
 * One sweep cell, one process. Env isolation is the point: tunables like
 * RERANK_POOL and MIN_VECTOR_SIM are read at module load, so cells sharing a
 * process cannot vary them. Restricted to frozen corpora (fixture,
 * trajectories) — same inputs, same index stats, comparable rows. Live
 * histories stay one-process (see run-eval.ts header) and are out of scope.
 *
 * Usage: node --import tsx scripts/sweep-cell.ts --corpus fixture --arms lexical,hybrid,rerank
 * Emits one JSON array of result rows on stdout.
 */
import { createHash } from "node:crypto";
import { readFileSync, mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp, closeApp, initVectors } from "../src/app.js";
import { backfillEmbeddings } from "../src/commands.js";
import { dumpConfig } from "../src/settings.js";
import { runEval, type EvalMode, type EvalRunResult } from "../src/eval/runner.js";
import { ndcgAtK, mrrAtK, precisionAtK } from "../src/eval/metrics.js";
import { searchOnce } from "../src/commands.js";
import { voyageMeter } from "../src/embeddings/voyage.js";
import { embedMeter, clearQueryVectorCache } from "../src/embeddings/provider.js";
import { jevMeter } from "../src/judgments/jev.js";
import { voyageRerankMeter, voyageRerankModel } from "../src/search/rerank-voyage.js";

const argValue = (flag: string): string | undefined => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

/** Semantic arms need vectors; lexical/judge arms run without them. */
const NEEDS_VECTORS = (mode: string): boolean =>
  !mode.startsWith("lexical") && !mode.startsWith("judge");

function corpusHash(corpus: string, goldenPath: string, extra = ""): string {
  const golden = readFileSync(goldenPath, "utf8");
  return createHash("sha256").update(corpus + "\n" + golden + "\n" + extra).digest("hex").slice(0, 12);
}

async function main() {
  const corpus = argValue("--corpus") ?? "fixture";
  const arms = (argValue("--arms") ?? "lexical").split(",").map((s) => s.trim()).filter(Boolean) as EvalMode[];
  // --golden overrides the corpus default: lets narrow probe sets (entity
  // queries, ablation slices) run through the same harness without churning
  // the committed golden files both corpora share for comparability.
  const goldenOverride = argValue("--golden");
  // --router deterministic|jev: per-query semantic planning (route.ts); the arm
  // label gains a +router suffix and reasons/skips go to stderr for the log.
  const router = argValue("--router") ?? null;
  if (router && router !== "deterministic" && router !== "jev") {
    throw new Error(`unknown --router "${router}" (want deterministic|jev)`);
  }
  const root = mkdtempSync(join(tmpdir(), "acg-cell-"));
  process.env.CONTEXT_GATEWAY_STATE = join(root, "state");
  // Dead-end dirs for every harness the corpus does NOT use. Live-writing
  // harnesses (opencode appends a session per `opencode run`) MUST be
  // included: 68 scoring runs once quoted every golden query verbatim into
  // the VM's opencode.db, and every subsequent fixture eval cited the echo
  // instead of the truth (judge Hit@1 0.952 -> 0.381 with zero code change).
  const { mkdirSync } = await import("node:fs");
  const deadEnd = (name: string) => {
    const d = join(root, name);
    mkdirSync(d, { recursive: true });
    return d;
  };
  const isolation = {
    cursorDb: deadEnd("empty-cursor"),
    zepDir: deadEnd("empty-zep"),
    opencodeDb: deadEnd("empty-opencode"),
  };

  let appOpts: Parameters<typeof createApp>[0];
  let goldenPath: string;
  let hash: string;
  if (corpus === "trajectories") {
    // Explicit empty dirs: never let a sweep touch real histories.
    const emptyClaude = join(root, "empty-claude");
    const emptyCodex = join(root, "empty-codex");
    mkdirSync(emptyClaude, { recursive: true });
    mkdirSync(emptyCodex, { recursive: true });
    appOpts = {
      indexDir: join(root, "index"),
      claudeDir: emptyClaude,
      codexDir: emptyCodex,
      trajectoryDir: join(process.cwd(), "tests", "fixtures", "trajectories"),
      ...isolation,
    };
    goldenPath = join(process.cwd(), "tests", "eval", "golden-trajectories.json");
    hash = corpusHash(corpus, goldenPath, "trajectories-v1");
  } else if (corpus === "fixture") {
    const { buildFixtureCorpus } = await import("../tests/fixtures/corpus.js");
    const { claudeDir, codexDir } = await buildFixtureCorpus(root);
    appOpts = { indexDir: join(root, "index"), claudeDir, codexDir, ...isolation };
    goldenPath = join(process.cwd(), "tests", "eval", "golden-fixture.json");
    hash = corpusHash(corpus, goldenPath, "fixture-v1");
  } else if (corpus === "real") {
    // Persistent real-history index (swe-data/, gitignored, never committed).
    // No build and no forced backfill: the index is maintained out of band
    // (sync-now + backfill), the cell only reads. Vectors attach if present.
    appOpts = {
      indexDir: "swe-data/real-index",
      claudeDir: "swe-data/real-claude",
      codexDir: "swe-data/real-codex",
      trajectoryDir: "swe-data/empty-traj",
      ...isolation,
    };
    process.env.CONTEXT_GATEWAY_STATE = "swe-data/real-state";
    goldenPath = goldenOverride
      ? ((await import("node:path")).isAbsolute(goldenOverride)
          ? goldenOverride
          : join(process.cwd(), goldenOverride))
      : join(process.cwd(), "swe-data", "golden-real.json");
    hash = corpusHash(corpus, goldenPath, "real-private");
  } else {
    throw new Error(`unknown --corpus "${corpus}" (want fixture|trajectories|real)`);
  }
  if (goldenOverride) {
    const { isAbsolute } = await import("node:path");
    goldenPath = isAbsolute(goldenOverride) ? goldenOverride : join(process.cwd(), goldenOverride);
    hash = corpusHash(corpus, goldenPath, "override");
  }
  // --traj-dir points the trajectories corpus at a sampled real-history dir
  // (default: the committed fixtures). Factored into the hash via dir listing.
  const trajDirOverride = argValue("--traj-dir");
  if (trajDirOverride && corpus === "trajectories") {
    const { isAbsolute } = await import("node:path");
    const { readdirSync, statSync } = await import("node:fs");
    const dir = isAbsolute(trajDirOverride) ? trajDirOverride : join(process.cwd(), trajDirOverride);
    appOpts = { ...appOpts, trajectoryDir: dir };
    const listing = readdirSync(dir).sort().join(",") + statSync(dir).size;
    hash = corpusHash(corpus, goldenPath, "trajdir:" + listing);
  }

  const app = createApp(appOpts);
  try {
    // Resolved engine (not the pin) is what prices the row: auto-resolution
    // picks voyage/voyage-code/voyage-context/none regardless of GATEWAY_EMBED_ENGINE.
    let engine = "none";
    if (arms.some(NEEDS_VECTORS)) {
      try {
        await initVectors(app);
        await backfillEmbeddings(app, {});
        const { resolveEngine } = await import("../src/embeddings/provider.js");
        engine = await resolveEngine();
      } catch {
        console.error("cell: vectors unavailable, semantic arms will degrade");
      }
    }
    const queries = JSON.parse(readFileSync(goldenPath, "utf8"));
    const config = dumpConfig();
    // Resolved backends, not pins: Lance vs sqlite-vec changes pools enough
    // to swing jev-pairwise ±0.10 cross-machine. Rows are only comparable
    // with equal vector_backend (pin via GATEWAY_VECTOR_BACKEND).
    const vectorBackend = app.vectorBackend ?? "none";
    const rows = [];
    for (const mode of arms) {
      voyageMeter.reset();
      jevMeter.reset();
      embedMeter.reset();
      voyageRerankMeter.reset();
      // Process-lifetime query-vector cache (provider.ts) would let later arms
      // ride the first arm's embeddings for free: correct results, wrong
      // per-arm metering. Clear so each arm meters its true API cost.
      clearQueryVectorCache();
      const r: EvalRunResult = router
        ? await runRouted(app, queries, mode, router)
        : await runEval(app, queries, mode);
      rows.push({
        corpus,
        corpusHash: hash,
        arm: r.mode,
        reranker: r.reranker ?? null,
        judgeMethod: r.judgeMethod ?? null,
        queries: r.totalQueries,
        ndcg5: r.overall.meanNdcg5,
        mrr5: r.overall.meanMrr5,
        p1: r.overall.meanP1,
        p5: r.overall.meanP5,
        latencyP50: r.overall.p50LatencyMs,
        byDomain: r.byDomain,
        judgeHit1: r.decisionCitations?.meanHitAt1 ?? null,
        config,
        engine,
        vectorBackend,
        voyage: voyageMeter.snapshot(),
        jev: jevMeter.snapshot(),
        voyageRerank: { ...voyageRerankMeter.snapshot(), model: voyageRerankModel() },
        embedFallbacks: embedMeter.snapshot().fallbacks,
      });
    }
    process.stdout.write(JSON.stringify(rows));
  } finally {
    closeApp(app);
  }
}

/**
 * Router cell: same metrics as runEval, but semantic comes from per-query
 * planning instead of the arm default. Rerank/judge behavior unchanged.
 */
async function runRouted(
  app: Parameters<typeof runEval>[0],
  queries: { id: string; domain: string; query: string; relevantSessionIds: string[] }[],
  mode: EvalMode,
  router: string,
): Promise<EvalRunResult> {
  const { planRetrieval, planRetrievalDeterministic } = await import("../src/search/route.js");
  // Same reranker the arm would install in runEval: without this the router
  // comparison silently swaps models (app default resolves Jev when keyed).
  const { armFor } = await import("../src/eval/runner.js");
  app.search.setReranker(armFor(mode).reranker());
  const reasons: Record<string, number> = {};
  let skipped = 0;
  let ndcg = 0;
  let mrr = 0;
  let p1 = 0;
  const byDom: Record<string, { n: number; s: number }> = {};
  for (const q of queries) {
    const plan =
      router === "deterministic" ? planRetrievalDeterministic(q.query) : await planRetrieval(q.query);
    reasons[plan.reason] = (reasons[plan.reason] ?? 0) + 1;
    if (!plan.semantic) skipped++;
    const res = await searchOnce(app, q.query, {
      maxResults: 5,
      semantic: plan.semantic,
      rerank: true,
    });
    const ids = [...new Set(res.results.map((r) => r.provenance.sessionId))];
    const n = ndcgAtK(ids, q.relevantSessionIds, 5);
    ndcg += n;
    mrr += mrrAtK(ids, q.relevantSessionIds, 5);
    p1 += precisionAtK(ids, q.relevantSessionIds, 1);
    byDom[q.domain] = byDom[q.domain] ?? { n: 0, s: 0 };
    byDom[q.domain].n++;
    byDom[q.domain].s += n;
  }
  const n = queries.length;
  process.stderr.write(`[router:${router}] skipped=${skipped}/${n} reasons=${JSON.stringify(reasons)}\n`);
  const overall = {
    domain: "overall",
    count: n,
    meanNdcg5: Number((ndcg / n).toFixed(4)),
    meanMrr5: Number((mrr / n).toFixed(4)),
    meanP1: Number((p1 / n).toFixed(4)),
    meanP5: 0,
    p50LatencyMs: 0,
    p95LatencyMs: 0,
  };
  return {
    mode: `${mode}+router-${router}`,
    timestamp: new Date().toISOString(),
    totalQueries: n,
    overall,
    byDomain: Object.fromEntries(
      Object.entries(byDom).map(([d, v]) => [
        d,
        { domain: d, count: v.n, meanNdcg5: Number((v.s / v.n).toFixed(4)), meanMrr5: 0, meanP1: 0, meanP5: 0, p50LatencyMs: 0, p95LatencyMs: 0 },
      ]),
    ),
    queryResults: [],
  };
}

main().catch((err) => {
  console.error("cell failed:", err);
  process.exit(1);
});
