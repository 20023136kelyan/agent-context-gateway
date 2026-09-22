#!/usr/bin/env node
/**
 * CLI script to execute the golden evaluation harness.
 * Usage:
 *   npx tsx scripts/run-eval.ts [--mode lexical,hybrid,rerank] [--save out.json]
 *                               [--as-of 2026-09-14T00:00:00Z]
 *                               [--golden tests/eval/golden-fixture.json]
 *                               [--index-dir /path/to/frozen-index]
 *   (rrf = alias of hybrid)
 *
 * --mode accepts a comma-separated list and runs every arm inside ONE process,
 * against one app and one index. That matters: BM25 IDF and average document
 * length shift as documents are committed, so numbers from two separate
 * processes are not comparable even at the same --as-of. Only within-run
 * orderings can be trusted.
 *
 * --as-of pins which turns may be RETURNED; it does not pin corpus statistics.
 * The complementary half is --index-dir: stop `serve`, copy the index, and point
 * every arm at the frozen copy so no external writer moves the corpus mid-run.
 * The run fails if docCount changes between the first and last arm, which turns
 * that drift from an invisible confound into an error.
 */
import { writeFileSync, mkdtempSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { createApp, closeApp, initVectors } from "../src/app.js";
import { backfillEmbeddings } from "../src/commands.js";
import {
  loadGoldenQueries,
  runEval,
  formatMarkdownTable,
  type EvalMode,
  type EvalRunResult,
  type GoldenQuery,
} from "../src/eval/runner.js";

const MODES: EvalMode[] = [
  "lexical", "lexical-rerank", "hybrid", "rerank", "rrf",
  "lexical-jev", "jev", "lexical-jev-pairwise", "jev-pairwise",
  "rerank-pure", "jev-pure", "rerank-voyage",
  "judge-neural", "judge-jev", "judge-jev-noul",
];

const argValue = (args: string[], flag: string): string | undefined => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};

function deltaTable(runs: EvalRunResult[]): string {
  const base = runs[0];
  const lines = [
    `### Comparison (baseline: ${base.mode})`,
    "",
    "| Arm | NDCG@5 | Δ | MRR@5 | P@1 | p50 ms | docs |",
    "|---|---:|---:|---:|---:|---:|---:|",
  ];
  for (const r of runs) {
    const d = r.overall.meanNdcg5 - base.overall.meanNdcg5;
    const delta = r === base ? "—" : `${d >= 0 ? "+" : ""}${d.toFixed(4)}`;
    lines.push(
      `| ${r.mode} | ${r.overall.meanNdcg5.toFixed(4)} | ${delta} | ${r.overall.meanMrr5.toFixed(4)} | ` +
        `${r.overall.meanP1.toFixed(4)} | ${r.overall.p50LatencyMs} | ${r.docCount ?? "?"} |`,
    );
  }
  lines.push("");
  lines.push(
    "_With a small golden set and binary session-level relevance, a delta under ~0.04 NDCG@5 is not evidence._",
  );
  return lines.join("\n");
}

async function main() {
  const args = process.argv.slice(2);
  const modeArg = argValue(args, "--mode") ?? "hybrid";
  const modes = modeArg.split(",").map((m) => m.trim()).filter(Boolean) as EvalMode[];
  for (const m of modes) {
    if (!MODES.includes(m)) throw new Error(`unknown --mode "${m}" (want ${MODES.join("|")})`);
  }
  const savePath = argValue(args, "--save");
  const asOf = argValue(args, "--as-of");
  if (asOf && Number.isNaN(new Date(asOf).getTime())) throw new Error(`bad --as-of "${asOf}" (want an ISO timestamp)`);
  const goldenPath = argValue(args, "--golden");
  const indexDir = argValue(args, "--index-dir");
  // --fixture runs against the committed synthetic corpus instead of the
  // machine's real agent history: reproducible anywhere, safe in CI, and small
  // enough to embed inside a free-tier rate limit.
  const useFixture = args.includes("--fixture");
  // --beir <dir> measures the same arms against an outside corpus nobody here
  // authored. See src/eval/beir.ts for why, and for what it is NOT comparable to.
  const beirDir = argValue(args, "--beir");
  const beirQueryCap = argValue(args, "--beir-queries");
  const beirDocCap = argValue(args, "--beir-docs");
  const beirSplit = argValue(args, "--beir-split");
  const beirDomain = argValue(args, "--beir-domain") as "code" | "prose" | "paraphrase" | undefined;
  if (beirDir && useFixture) throw new Error("--beir and --fixture are different corpora; pass one");
  let beirQueries: GoldenQuery[] | undefined;

  let appOpts: Parameters<typeof createApp>[0] = indexDir ? { indexDir } : {};
  if (beirDir) {
    const { buildBeirCorpus } = await import("../src/eval/beir.js");
    // --beir-root keeps the corpus, index and vectors across runs. Without it a
    // sweep re-embeds the whole corpus at every point (nfcorpus: 25 minutes).
    const beirRoot = argValue(args, "--beir-root");
    const root = beirRoot ?? mkdtempSync(join(tmpdir(), "acg-eval-beir-"));
    const built = await buildBeirCorpus(beirDir, root, {
      split: beirSplit,
      maxQueries: beirQueryCap ? Number(beirQueryCap) : undefined,
      maxDocs: beirDocCap ? Number(beirDocCap) : undefined,
      domain: beirDomain,
      reuse: Boolean(beirRoot),
    });
    beirQueries = built.queries;
    appOpts = {
      ...appOpts,
      claudeDir: built.claudeDir,
      codexDir: join(root, "codex-empty"),
      indexDir: indexDir ?? join(root, "index"),
    };
    process.env.CONTEXT_GATEWAY_STATE = join(root, "state");
    const st = built.stats;
    console.log(
      `BEIR ${st.name}/${beirSplit ?? "test"}: ${st.docsWritten} docs ` +
        `(${st.judgedDocs} judged + ${st.distractors} distractors${st.corpusTruncated ? ", TRUNCATED" : ""}), ` +
        `${st.queries} queries, ${st.meanRelevantPerQuery} relevant/query`,
    );
    if (st.corpusTruncated) {
      console.log(
        "  NOTE: corpus capped by --beir-docs. A smaller corpus is an EASIER benchmark — " +
          "absolute scores rise. Only compare arms measured at the same cap.",
      );
    }
  }
  if (useFixture) {
    const { buildFixtureCorpus } = await import("../tests/fixtures/corpus.js");
    const root = mkdtempSync(join(tmpdir(), "acg-eval-fixture-"));
    const { claudeDir, codexDir } = await buildFixtureCorpus(root);
    appOpts = { ...appOpts, claudeDir, codexDir, indexDir: indexDir ?? join(root, "index") };
    process.env.CONTEXT_GATEWAY_STATE = join(root, "state");
    console.log(`Fixture corpus built at ${root}`);
  }
  const app = createApp(appOpts);
  // Any arm but `lexical` reads vector candidates. Opening the store is not
  // enough: --fixture points the state dir at a fresh temp dir, so the store is
  // EMPTY and every semantic arm silently degrades to lexical. That failure is
  // invisible in the output — `hybrid` simply reports lexical's numbers — and
  // it invalidated a MIN_VECTOR_SIM sweep before this was noticed. So embed the
  // corpus before measuring, and refuse to report a semantic arm we know is
  // unbacked rather than printing a number that means nothing.
  const semanticModes = modes.filter((m) => m !== "lexical" && !m.startsWith("lexical-"));
  if (modes.some((m) => m !== "lexical")) {
    try {
      await initVectors(app);
    } catch {
      console.warn("Vectors initialization failed; continuing with lexical-only");
    }
  }
  if (semanticModes.length > 0 && app.vectors) {
    const t0 = Date.now();
    console.log(`Embedding corpus for semantic arms (${semanticModes.join(", ")})...`);
    const res = await backfillEmbeddings(app);
    const count = await app.vectors.count().catch(() => 0);
    console.log(
      `Embedded ${res.turnsEmbedded} turns (${res.turnsSkipped} already present) ` +
        `-> ${count} vector rows in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
    );
    if (count === 0) {
      throw new Error(
        `Semantic arms requested (${semanticModes.join(", ")}) but the vector store is empty` +
          `${res.reason ? `: ${res.reason}` : ""}. Those arms would report lexical numbers under a ` +
          `semantic name. Set an embedding key (VOYAGE_API_KEY) or run only lexical arms.`,
      );
    }
  }

  const queries =
    beirQueries ??
    loadGoldenQueries(goldenPath ?? (useFixture ? join(process.cwd(), "tests", "eval", "golden-fixture.json") : undefined));
  console.log(
    `Loaded ${queries.length} golden queries${goldenPath ? ` from ${goldenPath}` : ""}. ` +
      `Arms: ${modes.join(", ")}${asOf ? ` as of ${asOf}` : ""}...`,
  );

  const runs: EvalRunResult[] = [];
  try {
    for (const mode of modes) {
      const result = await runEval(app, queries, mode, { asOf });
      runs.push(result);
      console.log("\n" + formatMarkdownTable(result) + "\n");
    }
  } finally {
    closeApp(app);
  }

  // The corpus must not have moved underneath the comparison.
  const counts = runs.map((r) => r.docCount).filter((c): c is number => typeof c === "number");
  if (counts.length > 1 && new Set(counts).size > 1) {
    console.error(
      `\nCORPUS DRIFT: docCount changed across arms (${counts.join(" -> ")}). ` +
        `An external writer (serve --watch?) committed mid-run, so BM25 statistics moved and these arms are NOT comparable. ` +
        `Stop the server, copy the index, and re-run with --index-dir.`,
    );
    process.exit(2);
  }

  if (runs.length > 1) console.log(deltaTable(runs) + "\n");

  if (savePath) {
    // An absolute --save path is used as given; only relative ones hang off cwd.
    const out = isAbsolute(savePath) ? savePath : join(process.cwd(), savePath);
    // One arm saves the run itself, so existing baselines keep their shape.
    writeFileSync(out, JSON.stringify(runs.length === 1 ? runs[0] : runs, null, 2));
    console.log(`Saved evaluation results to ${out}`);
  }
}

main().catch((err) => {
  console.error("Evaluation failed:", err);
  process.exit(1);
});
