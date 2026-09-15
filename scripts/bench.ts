#!/usr/bin/env node
/**
 * Latency micro-benchmarks against the real local histories and index (read-only).
 * Usage:
 *   npx tsx scripts/bench.ts [--runs N] [--sync]
 * --sync also times a cold full sync into a throwaway index directory.
 */
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp, closeApp, initVectors } from "../src/app.js";
import { searchOnce, decideOnce } from "../src/commands.js";
import { syncAll } from "../src/indexing/sync.js";
import { getSharedReranker } from "../src/search/rerank.js";
import { extractDecisions } from "../src/decisions/extract.js";
import { loadGoldenQueries } from "../src/eval/runner.js";

const args = process.argv.slice(2);
const RUNS = args.includes("--runs") ? Number(args[args.indexOf("--runs") + 1]) : 3;

async function time<T>(label: string, fn: () => Promise<T> | T, runs = RUNS): Promise<T> {
  let out!: T;
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    out = await fn();
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)];
  console.log(`${label.padEnd(46)} median ${median.toFixed(1).padStart(9)} ms  (n=${runs})`);
  return out;
}

async function main() {
  const app = createApp({});
  try {
    await time("index.stats()", () => app.index.stats());
    await time("listSessions, all adapters", async () => {
      for (const a of app.adapters) await a.listSessions();
    });

    const codex = app.adapters.find((a) => a.harness === "codex")!;
    const codexSessions = (await codex.listSessions()).slice(0, 5);
    for (const s of codexSessions) await codex.listTurns(s.id); // warm parse caches
    await time(`codex listTurns x${codexSessions.length} (parse cache warm)`, async () => {
      for (const s of codexSessions) await codex.listTurns(s.id);
    });

    await initVectors(app).catch(() => null);
    const queries = loadGoldenQueries().map((q) => q.query);
    await searchOnce(app, queries[0]); // warm embedder, reranker-free caches
    const lexical = await time(`searchOnce lexical, ${queries.length} queries`, async () => {
      for (const q of queries) await searchOnce(app, q, { semantic: false });
    }, 1);
    void lexical;
    await time(`searchOnce hybrid, ${queries.length} queries`, async () => {
      for (const q of queries) await searchOnce(app, q);
    }, 1);

    const res = await searchOnce(app, queries[0], { maxResults: 15, semantic: false });
    const cands = res.results
      .flatMap((r) => r.context)
      .slice(0, 15)
      .map((t, i) => ({ id: `${t.id}#${i}`, content: t.content, score: 0.5 }));
    const reranker = getSharedReranker();
    await reranker.rerank(queries[0], cands.slice(0, 2)); // load the model
    await time(`rerank ${cands.length} candidates`, () => reranker.rerank(queries[0], cands, 15));

    const claude = app.adapters.find((a) => a.harness === "claude-code")!;
    const claudeSessions = await claude.listSessions();
    const sized = await Promise.all(claudeSessions.map(async (s) => ({ s, size: (await stat(s.sourcePath)).size })));
    const biggest = sized.sort((a, b) => b.size - a.size)[0]?.s;
    if (biggest) {
      const turns = await claude.listTurns(biggest.id);
      await time(`extractDecisions, ${turns.length} turns`, () => extractDecisions(biggest.id, turns, ["decide", "architecture"]));
    }
    await time("decideOnce", () => decideOnce(app, "Why did we choose Tantivy over SQLite?"), 1);
  } finally {
    closeApp(app);
  }

  if (args.includes("--sync")) {
    const dir = await mkdtemp(join(tmpdir(), "acg-bench-sync-"));
    const cold = createApp({ indexDir: dir });
    try {
      const r = await time("cold full sync (throwaway index)", () => syncAll(cold.adapters, cold.index, cold.cursors), 1);
      console.log(`  -> ${r.sessionsIndexed} sessions, ${r.turnsIndexed} turns, ${r.docCount} docs`);
      await time("no-change incremental sync", () => syncAll(cold.adapters, cold.index, cold.cursors));
    } finally {
      closeApp(cold);
      await rm(dir, { recursive: true, force: true });
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
