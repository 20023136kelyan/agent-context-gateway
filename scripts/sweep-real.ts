#!/usr/bin/env node
/**
 * One-factor sweep of ranking constants on real history (item 11: the
 * defaults were tuned on the 72-session fixture corpus).
 *
 * Every cell is its own run-eval.ts process, because the constants are read
 * when their modules load. Cells share one --real root, so they share its
 * index and vectors: nothing is re-embedded unless a cell points
 * GATEWAY_VECTOR_DIR somewhere new (the chunk-size cells do). Run cells one
 * at a time; they all open the same index.
 *
 * The strict and broad mined sets are merged into one golden file with the
 * set as each query's domain, so one run scores both and the report splits
 * them. Each cell is compared per query with the baseline: mean NDCG@5 delta,
 * and how many queries got better or worse (a small mean delta carried by
 * two queries is not a better default).
 *
 * Usage:
 *   npx tsx scripts/sweep-real.ts --real <root> [--mode hybrid] [--out <file>]
 *     --cell "name:VAR=value,VAR2=value" [--cell ...]
 * A baseline cell (no overrides) always runs first.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

interface QueryResult { id: string; domain: string; ndcg5: number }
interface ModeResult { mode: string; overall: { meanNdcg5: number; p50LatencyMs: number }; byDomain: Record<string, { count: number; meanNdcg5: number }>; queryResults: QueryResult[] }
interface Cell { name: string; env: Record<string, string> }

const args = process.argv.slice(2);
const value = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const root = value("--real");
if (!root) throw new Error("usage: sweep-real --real <root> --cell name:VAR=v,... [--mode hybrid]");
const mode = value("--mode") ?? "hybrid";
const out = value("--out") ?? join(root, `sweep-${mode}.json`);

const cells: Cell[] = [{ name: "baseline", env: {} }];
args.forEach((a, i) => {
  if (a !== "--cell") return;
  const spec = args[i + 1]!;
  const [name, rest = ""] = spec.split(":");
  const env = Object.fromEntries(rest.split(",").filter(Boolean).map((kv) => kv.split("=") as [string, string]));
  cells.push({ name: name!, env });
});

// Strict and broad in one file, the set as the domain.
const merged = join(root, "golden-merged.json");
const tag = (file: string, domain: string) =>
  (JSON.parse(readFileSync(join(root, file), "utf8")) as { id: string }[]).map((q) => ({ ...q, id: `${domain}:${q.id}`, domain }));
writeFileSync(merged, JSON.stringify([...tag("golden-pairs.json", "strict"), ...(existsSync(join(root, "golden-pairs-broad.json")) ? tag("golden-pairs-broad.json", "broad") : [])]));

const results: { cell: Cell; run: ModeResult; seconds: number }[] = [];
for (const cell of cells) {
  const save = join(root, `sweep-cell-${cell.name}.json`);
  const t0 = Date.now();
  const r = spawnSync(
    process.execPath,
    ["--env-file-if-exists=.env", "--import", "tsx", "scripts/run-eval.ts", "--real", root, "--golden", merged, "--mode", mode, "--project-scope", "filter", "--save", save],
    { env: { ...process.env, ...cell.env }, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (r.status !== 0) {
    console.error(`cell ${cell.name} failed:\n${(r.stderr ?? "").slice(-2000)}`);
    continue;
  }
  // One mode saves a single result, several save a list.
  const saved = JSON.parse(readFileSync(save, "utf8")) as ModeResult | ModeResult[];
  const runs = Array.isArray(saved) ? saved : [saved];
  results.push({ cell, run: runs.find((x) => x.mode === mode) ?? runs[0]!, seconds: (Date.now() - t0) / 1000 });
  const last = results[results.length - 1]!;
  console.error(`done ${cell.name} in ${last.seconds.toFixed(0)}s: ${last.run.overall.meanNdcg5.toFixed(4)}`);
}

const base = results.find((x) => x.cell.name === "baseline");
if (!base) throw new Error("baseline failed");
const byId = (run: ModeResult) => new Map(run.queryResults.map((q) => [q.id, q.ndcg5]));
const baseIds = byId(base.run);
const domains = Object.keys(base.run.byDomain).sort();
const lines = [
  `| cell | ${domains.map((d) => `${d} NDCG@5 (Δ, +/−)`).join(" | ")} | p50 ms |`,
  `|---|${domains.map(() => "---:|").join("")}---:|`,
];
for (const { cell, run } of results) {
  const ids = byId(run);
  const cols = domains.map((d) => {
    const mean = run.byDomain[d]?.meanNdcg5 ?? NaN;
    if (cell.name === "baseline") return mean.toFixed(4);
    let up = 0;
    let down = 0;
    for (const q of run.queryResults) {
      if (q.domain !== d) continue;
      const b = baseIds.get(q.id) ?? 0;
      if (ids.get(q.id)! > b + 1e-9) up += 1;
      else if (ids.get(q.id)! < b - 1e-9) down += 1;
    }
    const delta = mean - (base.run.byDomain[d]?.meanNdcg5 ?? NaN);
    return `${mean.toFixed(4)} (${delta >= 0 ? "+" : ""}${delta.toFixed(4)}, +${up}/−${down})`;
  });
  const label = cell.name === "baseline" ? "baseline" : `${cell.name} (${Object.entries(cell.env).map(([k, v]) => `${k.replace(/^GATEWAY_/, "")}=${v}`).join(", ")})`;
  lines.push(`| ${label} | ${cols.join(" | ")} | ${run.overall.p50LatencyMs} |`);
}
console.log(lines.join("\n"));
writeFileSync(out, JSON.stringify(results.map((x) => ({ cell: x.cell, seconds: x.seconds, overall: x.run.overall, byDomain: x.run.byDomain, queryResults: x.run.queryResults })), null, 2));
console.error(`saved ${out}`);
