#!/usr/bin/env node
/**
 * CLI script to execute the golden evaluation harness.
 * Usage:
 *   npx tsx scripts/run-eval.ts [--mode lexical|hybrid|rerank] [--save baseline.json]
 *                               [--as-of 2026-09-14T00:00:00Z]
 *   (rrf = alias of hybrid)
 *
 * --as-of pins the corpus to a point in time. Without it a run scores against
 * whatever has been indexed since — including the session doing the evaluating,
 * whose transcript quotes every golden query verbatim — so two runs of the same
 * code disagree. The golden set's newest relevant turn is 2026-09-13.
 */
import { writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { createApp, closeApp, initVectors } from "../src/app.js";
import { loadGoldenQueries, runEval, formatMarkdownTable, type EvalMode } from "../src/eval/runner.js";

const MODES: EvalMode[] = ["lexical", "hybrid", "rerank", "rrf"];

async function main() {
  const args = process.argv.slice(2);
  const modeIdx = args.indexOf("--mode");
  const mode = (modeIdx >= 0 ? args[modeIdx + 1] : "hybrid") as EvalMode;
  if (!MODES.includes(mode)) throw new Error(`unknown --mode "${mode}" (want ${MODES.join("|")})`);
  const saveIdx = args.indexOf("--save");
  const savePath = saveIdx >= 0 ? args[saveIdx + 1] : undefined;
  const asOfIdx = args.indexOf("--as-of");
  const asOf = asOfIdx >= 0 ? args[asOfIdx + 1] : undefined;
  if (asOf && Number.isNaN(new Date(asOf).getTime())) throw new Error(`bad --as-of "${asOf}" (want an ISO timestamp)`);

  const app = createApp({});
  if (mode !== "lexical") {
    try {
      await initVectors(app);
    } catch {
      console.warn("Vectors initialization failed; continuing with lexical-only");
    }
  }

  const queries = loadGoldenQueries();
  console.log(`Loaded ${queries.length} golden queries. Evaluating mode: ${mode}${asOf ? ` as of ${asOf}` : ""}...`);

  const result = await runEval(app, queries, mode, { asOf });
  closeApp(app);

  console.log("\n" + formatMarkdownTable(result) + "\n");

  if (savePath) {
    // An absolute --save path is used as given; only relative ones hang off cwd.
    const out = isAbsolute(savePath) ? savePath : join(process.cwd(), savePath);
    writeFileSync(out, JSON.stringify(result, null, 2));
    console.log(`Saved evaluation results to ${out}`);
  }
}

main().catch((err) => {
  console.error("Evaluation failed:", err);
  process.exit(1);
});
