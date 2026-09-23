#!/usr/bin/env node
/**
 * Calibrate proactive context (src/proactive.ts) on mined real history.
 *
 * Each mined query is a session's opening prompt, exactly what the
 * UserPromptSubmit hook sees, pinned to the moment it was asked (asOf) in the
 * project it was asked from. Positives (golden-pairs*.json) have an earlier
 * session that did related work; negatives (golden-negatives.json) have
 * earlier history in the project but none sharing an edited file.
 *
 * The gate's probability is collected once per candidate (threshold 0), then
 * every threshold is scored offline: same judgments, no re-querying, so the
 * thresholds differ only by where the line is drawn.
 *
 *   positives: injected = share of prompts that got anything;
 *              precision = injected items that are relevant sessions;
 *              hit = share of prompts that got at least one relevant session
 *   negatives: false alarms = share of prompts that got anything
 *
 * Usage: npx tsx scripts/eval-proactive.ts --real <root> [--positives <file>] [--thresholds 0.5,0.6,0.7,0.8,0.9]
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createApp, closeApp } from "../src/app.js";
import { proactiveContext, type ProactiveItem } from "../src/proactive.js";
import { httpJevClient, jevAvailable, jevMeter } from "../src/judgments/jev.js";

interface Mined { id: string; query: string; asOf: string; project: string; relevantSessionIds: string[]; mined: { querySession: string } }

function argValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const root = argValue(args, "--real");
  if (!root) throw new Error("usage: eval-proactive --real <root> [--positives <file>] [--thresholds ...]");
  const positives = JSON.parse(readFileSync(argValue(args, "--positives") ?? join(root, "golden-pairs.json"), "utf8")) as Mined[];
  const negatives = JSON.parse(readFileSync(join(root, "golden-negatives.json"), "utf8")) as Mined[];
  const thresholds = (argValue(args, "--thresholds") ?? "0.5,0.6,0.7,0.8,0.9").split(",").map(Number);
  // Without a key every judgment fails quietly and every threshold reads 0:
  // a number that means nothing. Refuse instead (run via `npm run eval:proactive`,
  // which loads .env).
  if (!jevAvailable()) throw new Error("TYPESAFE_API_KEY is not set: the gate cannot run, so there is nothing to calibrate");

  const dead = (n: string) => {
    const d = join(root, n);
    mkdirSync(d, { recursive: true });
    return d;
  };
  process.env.CONTEXT_GATEWAY_STATE = join(root, "state");
  const app = createApp({
    stateDir: join(root, "state"), claudeDir: join(root, "claude"), codexDir: join(root, "codex"), indexDir: join(root, "index"),
    cursorDb: dead("empty-cursor"), zepDir: dead("empty-zep"), opencodeDb: dead("empty-opencode"), trajectoryDir: dead("empty-trajectories"), gitRepos: [],
  });
  const judged: { q: Mined; positive: boolean; items: ProactiveItem[]; ms: number }[] = [];
  try {
    for (const [set, positive] of [[positives, true], [negatives, false]] as const) {
      for (const q of set) {
        const t0 = Date.now();
        const res = await proactiveContext(
          app,
          { prompt: q.query, project: q.project, sessionId: q.mined.querySession, asOf: q.asOf },
          { gate: httpJevClient, threshold: 0, maxItems: 5, remember: false },
        );
        judged.push({ q, positive, items: res.items, ms: Date.now() - t0 });
        process.stderr.write(`[${positive ? "pos" : "neg"} ${q.id}] ${res.items.length} candidates ${Date.now() - t0}ms\n`);
      }
    }
  } finally {
    closeApp(app);
  }

  const rows = thresholds.map((tau) => {
    const pick = (items: ProactiveItem[]) => items.filter((i) => i.via === "action" || (i.p ?? 0) >= tau).slice(0, 3);
    const pos = judged.filter((j) => j.positive).map((j) => ({ j, got: pick(j.items) }));
    const neg = judged.filter((j) => !j.positive).map((j) => ({ j, got: pick(j.items) }));
    const injected = pos.filter((x) => x.got.length > 0);
    const items = pos.flatMap((x) => x.got.map((i) => x.j.q.relevantSessionIds.includes(i.sessionId)));
    const hits = pos.filter((x) => x.got.some((i) => x.j.q.relevantSessionIds.includes(i.sessionId)));
    return {
      threshold: tau,
      injected: +(injected.length / pos.length).toFixed(3),
      precision: items.length ? +(items.filter(Boolean).length / items.length).toFixed(3) : null,
      hit: +(hits.length / pos.length).toFixed(3),
      falseAlarms: +(neg.filter((x) => x.got.length > 0).length / Math.max(1, neg.length)).toFixed(3),
    };
  });
  const lat = judged.map((j) => j.ms).sort((a, b) => a - b);
  console.log(`positives ${positives.length}, negatives ${negatives.length}, Jev requests ${jevMeter.requests}, p50 ${lat[Math.floor(lat.length / 2)]}ms, p95 ${lat[Math.floor(lat.length * 0.95)]}ms`);
  console.log("| threshold | injected (pos) | precision | hit (pos) | false alarms (neg) |");
  console.log("|---:|---:|---:|---:|---:|");
  for (const r of rows) console.log(`| ${r.threshold} | ${r.injected} | ${r.precision ?? "—"} | ${r.hit} | ${r.falseAlarms} |`);
  writeFileSync(join(root, "run-proactive.json"), JSON.stringify({ rows, judged: judged.map((j) => ({ id: j.q.id, positive: j.positive, ms: j.ms, items: j.items.map((i) => ({ sessionId: i.sessionId, via: i.via, p: i.p, relevant: j.q.relevantSessionIds.includes(i.sessionId) })) })) }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
