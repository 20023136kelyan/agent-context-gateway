#!/usr/bin/env node
/**
 * Sweep runner (W2): manifest-driven parallel eval cells with cost metering.
 *
 * Manifest: { out: "sweeps/results.sqlite", jobs: 2, cells: [
 *   { name: "baseline", corpus: "fixture", arms: ["lexical","hybrid","rerank"], env: {} },
 *   { name: "gate-025",  corpus: "fixture", arms: ["lexical","hybrid","rerank"], env: { GATEWAY_MIN_VECTOR_SIM: "0.25" } },
 * ]}
 *
 * Each cell runs in its own process (see sweep-cell.ts header for why).
 * Frozen corpora are input-identical across cells, so rows are comparable;
 * the corpus hash in every row proves it. Results land in SQLite with full
 * config + usage per row: NDCG deltas AND $/query deltas in one table.
 *
 * Usage: npm run sweep -- sweeps/example.json
 */
import { spawnSync } from "node:child_process";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname, join, isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** $/M input tokens, official tables 2026. Voyage billing + TypeSafe Jev
 *  ($0.042/M in, output free). Both directions now priced: est_cost_usd is
 *  the full third-party cost of the row. */
import { ENGINE_DEFS, RERANKER_DEFS } from "../src/components.js";

/** Cost basis lives with the components; the sweep only reads it. */
const VOYAGE_ENGINE_PRICE: Record<string, number> = Object.fromEntries(
  ENGINE_DEFS.filter((e) => e.pricePerM !== null).map((e) => [e.name, e.pricePerM as number]),
);
const JEV_PRICE_PER_M_INPUT =
  (RERANKER_DEFS.find((r) => r.name === "jev")?.pricePerM ?? 0.042) as number;
const VOYAGE_RERANK_PRICE_PER_M: Record<string, number> = {
  "rerank-2.5": 0.05,
  "rerank-2.5-lite": 0.02,
  "rerank-3": 0.05,
  "rerank-3-lite": 0.02,
};

interface Cell {
  name: string;
  corpus: "fixture" | "trajectories" | "real";
  arms: string[];
  env?: Record<string, string>;
  /** Per-query semantic planning (route.ts); recorded in the arm label. */
  router?: "deterministic" | "jev";
  /** Golden-file override (relative to repo root); keeps probe sets out of
   *  the committed files. Factored into the corpus hash. */
  golden?: string;
  /** Trajectory-dir override for the trajectories corpus (sampled data). */
  trajDir?: string;
}
interface Manifest {
  out: string;
  jobs?: number;
  cells: Cell[];
}

function estCostUsd(row: {
  voyage: { tokens: number }; engine: string;
  jev: { inputTokens: number };
  voyageRerank?: { tokens: number; model: string };
}): number | null {
  let cost = 0;
  let priced = false;
  const toks = row.voyage.tokens;
  if (toks > 0 && row.engine in VOYAGE_ENGINE_PRICE) {
    cost += (toks / 1e6) * VOYAGE_ENGINE_PRICE[row.engine];
    priced = true;
  }
  if (row.jev.inputTokens > 0) {
    cost += (row.jev.inputTokens / 1e6) * JEV_PRICE_PER_M_INPUT;
    priced = true;
  }
  const rr = row.voyageRerank;
  if (rr && rr.tokens > 0) {
    cost += (rr.tokens / 1e6) * (VOYAGE_RERANK_PRICE_PER_M[rr.model] ?? 0.05);
    priced = true;
  }
  if (!priced) {
    const clean = row.voyage.tokens === 0 && row.jev.inputTokens === 0 && !(rr && rr.tokens > 0);
    return clean ? 0 : null;
  }
  return cost;
}

async function main() {
  const manifestPath = process.argv[2];
  if (!manifestPath) throw new Error("usage: sweep <manifest.json>");
  const mp = isAbsolute(manifestPath) ? manifestPath : join(process.cwd(), manifestPath);
  const manifest = JSON.parse(readFileSync(mp, "utf8")) as Manifest;
  if (!Array.isArray(manifest.cells) || manifest.cells.length === 0) throw new Error("manifest needs a non-empty cells array");

  const out = isAbsolute(manifest.out) ? manifest.out : join(process.cwd(), manifest.out);
  mkdirSync(dirname(out), { recursive: true });
  const db = new DatabaseSync(out);
  db.exec(`CREATE TABLE IF NOT EXISTS sweep_rows (
    id INTEGER PRIMARY KEY, ts TEXT, cell TEXT, corpus TEXT, corpus_hash TEXT,
    arm TEXT, queries INTEGER, ndcg5 REAL, mrr5 REAL, p1 REAL, p5 REAL,
    latency_p50 INTEGER, judge_hit1 REAL, engine TEXT, vector_backend TEXT, embed_fallbacks INTEGER,
    config_json TEXT, by_domain_json TEXT,
    voyage_tokens INTEGER, voyage_requests INTEGER,
    jev_requests INTEGER, jev_in INTEGER, jev_out INTEGER,
    rr_tokens INTEGER, rr_requests INTEGER, rr_model TEXT, est_cost_usd REAL
  )`);
  const insert = db.prepare(`INSERT INTO sweep_rows
    (ts, cell, corpus, corpus_hash, arm, queries, ndcg5, mrr5, p1, p5, latency_p50,
     judge_hit1, engine, vector_backend, embed_fallbacks, config_json, by_domain_json, voyage_tokens, voyage_requests,
     jev_requests, jev_in, jev_out, rr_tokens, rr_requests, rr_model, est_cost_usd)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  // Sequential spawn loop (jobs>1 left for the cloud runner: same manifest,
  // sharded by cell index). One cell = one env-isolated process.
  for (const cell of manifest.cells) {
    console.log(`\n=== cell ${cell.name} (${cell.corpus}: ${cell.arms.join(",")}) ===`);
    const res = spawnSync(
      process.execPath,
      ["--env-file-if-exists=.env", "--import", "tsx", "scripts/sweep-cell.ts",
        "--corpus", cell.corpus, "--arms", cell.arms.join(","),
        ...(cell.router ? ["--router", cell.router] : []),
        ...(cell.golden ? ["--golden", cell.golden] : []),
        ...(cell.trajDir ? ["--traj-dir", cell.trajDir] : [])],
      {
        cwd: process.cwd(),
        env: { ...process.env, ...(cell.env ?? {}) },
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    if (res.status !== 0) {
      console.error(`cell ${cell.name} failed:\n${res.stderr.slice(-2000)}`);
      process.exitCode = 1;
      continue;
    }
    const rows = JSON.parse(res.stdout) as Record<string, never>[];
    const ts = new Date().toISOString();
    for (const r of rows as unknown as {
      corpus: string; corpusHash: string; arm: string; queries: number;
      ndcg5: number; mrr5: number; p1: number; p5: number; latencyP50: number;
      judgeHit1: number | null; engine: string; vectorBackend: string; embedFallbacks: number;
      config: Record<string, unknown>; byDomain: Record<string, unknown>;
      voyage: { tokens: number; requests: number }; jev: { requests: number; inputTokens: number; outputTokens: number };
      voyageRerank?: { tokens: number; requests: number; model: string };
    }[]) {
      const cost = estCostUsd(r);
      const rr = r.voyageRerank ?? { tokens: 0, requests: 0, model: "" };
      insert.run(ts, cell.name, r.corpus, r.corpusHash, r.arm, r.queries,
        r.ndcg5, r.mrr5, r.p1, r.p5, r.latencyP50, r.judgeHit1, r.engine, r.vectorBackend, r.embedFallbacks,
        JSON.stringify(r.config), JSON.stringify(r.byDomain),
        r.voyage.tokens, r.voyage.requests, r.jev.requests, r.jev.inputTokens, r.jev.outputTokens,
        rr.tokens, rr.requests, rr.model, cost);
      const flag = r.embedFallbacks > 0 ? ` FALLBACKS=${r.embedFallbacks} (non-comparable)` : "";
      console.log(`  ${r.arm}: ndcg=${r.ndcg5.toFixed(4)} p1=${r.p1.toFixed(3)} ` +
        `eng=${r.engine} voyTok=${r.voyage.tokens} jevReq=${r.jev.requests} cost=${cost === null ? "n/a" : "$" + cost.toFixed(4)}${flag}`);
    }
  }
  db.close();
  console.log(`\nSaved to ${out}`);
}

main().catch((err) => {
  console.error("sweep failed:", err);
  process.exit(1);
});
