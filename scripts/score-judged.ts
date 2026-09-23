#!/usr/bin/env node
/**
 * Judged eval, step 3 of 3: score saved eval runs against the judge's grades.
 *
 * For each run (a sweep-cell JSON), per query: graded NDCG@5 over its ranked
 * distinct sessions, gain 2^grade - 1, ideal from every judged session for
 * that query (the pool), so runs compared on one pool share one ideal. Also
 * P@1 (top session graded 2) and "any useful" (a grade 2 in the top 5). The
 * mined file-overlap NDCG is shown beside it: where the two disagree is the
 * point of judging.
 *
 * Coverage says how many of a run's top-5 sessions have a grade. A run whose
 * results were not in the pool reads low for that reason alone: pool it first
 * (judge-pool.ts) and judge (judge-pairs.ts).
 *
 * Usage: npx tsx scripts/score-judged.ts --judgments <judgments.jsonl> --cells a.json,b.json [--baseline a.json]
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";

const args = process.argv.slice(2);
const value = (n: string) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};
const judgmentsFile = value("--judgments");
const cellFiles = value("--cells")?.split(",").filter(Boolean) ?? [];
if (!judgmentsFile || cellFiles.length === 0) throw new Error("usage: score-judged --judgments j.jsonl --cells a.json,b.json");

const grade = new Map<string, number>();
const perQuery = new Map<string, number[]>();
for (const l of readFileSync(judgmentsFile, "utf8").split("\n").filter(Boolean)) {
  const j = JSON.parse(l) as { qid: string; sessionId: string; grade: number };
  grade.set(`${j.qid}|${j.sessionId}`, j.grade);
  perQuery.set(j.qid, [...(perQuery.get(j.qid) ?? []), j.grade]);
}

const gain = (g: number) => 2 ** g - 1;
const dcg = (gs: number[]) => gs.slice(0, 5).reduce((s, g, i) => s + gain(g) / Math.log2(i + 2), 0);

interface QueryResult { id: string; domain: string; ndcg5: number; topSessionIds: string[] }
const rows: string[] = [
  "| run | domain | judged NDCG@5 | P@1 (grade 2) | useful in top 5 | mined NDCG@5 | coverage |",
  "|---|---|---:|---:|---:|---:|---:|",
];
for (const f of cellFiles) {
  const saved = JSON.parse(readFileSync(f, "utf8"));
  const run = (Array.isArray(saved) ? saved[saved.length - 1] : saved) as { queryResults: QueryResult[] };
  const byDomain = new Map<string, QueryResult[]>();
  for (const q of run.queryResults) byDomain.set(q.domain, [...(byDomain.get(q.domain) ?? []), q]);
  for (const [domain, qs] of [...byDomain.entries()].sort()) {
    let nd = 0, p1 = 0, useful = 0, mined = 0, graded = 0, shown = 0, n = 0;
    for (const q of qs) {
      const ideal = dcg([...(perQuery.get(q.id) ?? [])].sort((a, b) => b - a));
      const gs = q.topSessionIds.slice(0, 5).map((s) => grade.get(`${q.id}|${s}`));
      shown += gs.length;
      graded += gs.filter((g) => g !== undefined).length;
      const known = gs.map((g) => g ?? 0);
      nd += ideal > 0 ? dcg(known) / ideal : 0;
      p1 += known[0] === 2 ? 1 : 0;
      useful += known.includes(2) ? 1 : 0;
      mined += q.ndcg5;
      n += 1;
    }
    rows.push(`| ${basename(f, ".json")} | ${domain} | ${(nd / n).toFixed(4)} | ${(p1 / n).toFixed(3)} | ${(useful / n).toFixed(3)} | ${(mined / n).toFixed(4)} | ${shown ? ((100 * graded) / shown).toFixed(0) : "-"}% |`);
  }
}
console.log(rows.join("\n"));
