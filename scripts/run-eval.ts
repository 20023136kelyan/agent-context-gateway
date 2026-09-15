#!/usr/bin/env node
/**
 * CLI script to execute the golden evaluation harness.
 * Usage:
 *   npx tsx scripts/run-eval.ts [--mode lexical|hybrid|rerank] [--save baseline.json]
 *   (rrf = alias of hybrid)
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
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

  const app = createApp({});
  if (mode !== "lexical") {
    try {
      await initVectors(app);
    } catch {
      console.warn("Vectors initialization failed; continuing with lexical-only");
    }
  }

  const queries = loadGoldenQueries();
  console.log(`Loaded ${queries.length} golden queries. Evaluating mode: ${mode}...`);

  const result = await runEval(app, queries, mode);
  closeApp(app);

  console.log("\n" + formatMarkdownTable(result) + "\n");

  if (savePath) {
    const out = join(process.cwd(), savePath);
    writeFileSync(out, JSON.stringify(result, null, 2));
    console.log(`Saved evaluation results to ${out}`);
  }
}

main().catch((err) => {
  console.error("Evaluation failed:", err);
  process.exit(1);
});
