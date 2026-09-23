#!/usr/bin/env node
/**
 * Measure session outcome records (src/outcomes/outcome.ts) on real history.
 *
 * There is no ground truth for "how did this session end", so this reports
 * what can be counted and writes a sample to read by hand:
 *
 *   coverage  how often each field is filled: a problem found, edits, checks,
 *             a check whose result the history records, commit/revert,
 *             the user's reaction; the status distribution, per harness
 *   cost      time to build one record, and what attaching outcomes adds to
 *             a search (lexical, the mined queries at their asOf)
 *   audit     a sample per status (seeded) with the record and the evidence
 *             it cites, written to <root>/outcome-audit.jsonl for review
 *
 * Builds its own index under <root>/outcome-run, so it never disturbs the
 * retrieval eval's. Needs no API key.
 *
 * Usage: npx tsx scripts/eval-outcomes.ts --real <root> [--per-status 6] [--seed 7]
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createApp, closeApp } from "../src/app.js";
import { syncNow, searchOnce, sessionOutcome } from "../src/commands.js";
import type { SessionOutcome } from "../src/outcomes/outcome.js";

interface Mined { id: string; query: string; asOf: string; project: string }

const argValue = (args: string[], name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(0)}%` : "-");
const quantile = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))]! : 0;
};
/** Deterministic shuffle (mulberry32), so the audit sample is reproducible. */
function shuffle<T>(xs: T[], seed: number): T[] {
  let a = seed >>> 0;
  const rand = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const root = argValue(args, "--real");
  if (!root) throw new Error("usage: eval-outcomes --real <root> [--per-status 6] [--seed 7]");
  const perStatus = Number(argValue(args, "--per-status") ?? 6);
  const seed = Number(argValue(args, "--seed") ?? 7);
  const run = join(root, "outcome-run");
  const dead = (n: string) => {
    const d = join(run, n);
    mkdirSync(d, { recursive: true });
    return d;
  };
  const app = createApp({
    stateDir: join(run, "state"), indexDir: join(run, "index"), backend: "sqlite",
    claudeDir: join(root, "claude"), codexDir: join(root, "codex"),
    cursorDb: dead("empty-cursor"), zepDir: dead("empty-zep"), opencodeDb: dead("empty-opencode"), trajectoryDir: dead("empty-trajectories"), gitRepos: [],
  });
  try {
    const t0 = Date.now();
    await syncNow(app);
    console.log(`synced in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

    const records: SessionOutcome[] = [];
    const ms: number[] = [];
    for (const adapter of app.adapters) {
      for (const s of await adapter.listSessions().catch(() => [])) {
        const t = performance.now();
        records.push(await sessionOutcome(app, adapter.harness, s.id));
        ms.push(performance.now() - t);
      }
    }

    const rows: string[] = ["| | sessions | problem found | edits | checks | check result known | verified | failing | unverified | no-edits | committed | reverted | user: problem | user: success |", "|---|" + "---:|".repeat(13)];
    for (const h of ["all", ...new Set(records.map((r) => r.harness))]) {
      const rs = h === "all" ? records : records.filter((r) => r.harness === h);
      const n = rs.length;
      const c = (f: (r: SessionOutcome) => boolean) => pct(rs.filter(f).length, n);
      rows.push(
        `| ${h} | ${n} | ${c((r) => r.problem !== null)} | ${c((r) => r.edits.count > 0)} | ${c((r) => r.checks.length > 0)} | ${c((r) => r.checks.some((k) => k.ok !== null))} | ` +
          `${c((r) => r.status === "verified")} | ${c((r) => r.status === "failing")} | ${c((r) => r.status === "unverified")} | ${c((r) => r.status === "no-edits")} | ` +
          `${c((r) => r.committed)} | ${c((r) => r.reverted)} | ${c((r) => r.userReported?.tone === "problem")} | ${c((r) => r.userReported?.tone === "success")} |`,
      );
    }
    console.log(rows.join("\n"));
    const tasks = records.flatMap((r) => r.tasks.map((t) => ({ r, t })));
    const tc = (f: (x: (typeof tasks)[number]) => boolean) => pct(tasks.filter(f).length, tasks.length);
    const multi = records.filter((r) => r.tasks.length > 1).length;
    console.log(
      `tasks: ${tasks.length} in ${records.length} sessions (${pct(multi, records.length)} of sessions have more than one; max ${Math.max(0, ...records.map((r) => r.tasks.length))})\n` +
        `  per task: verified ${tc((x) => x.t.status === "verified")}, failing ${tc((x) => x.t.status === "failing")}, unverified ${tc((x) => x.t.status === "unverified")}, no-edits ${tc((x) => x.t.status === "no-edits")}; ` +
        `reaction problem ${tc((x) => x.t.reaction?.tone === "problem")}, success ${tc((x) => x.t.reaction?.tone === "success")}`,
    );
    const failing = tasks.filter((x) => x.t.status === "failing");
    const noEdits = tasks.filter((x) => x.t.status === "no-edits");
    console.log(
      `  failing tasks already failing before their edits: ${pct(failing.filter((x) => x.t.alreadyFailing).length, failing.length)} of ${failing.length}; ` +
        `no-edits tasks with shell commands that may write files: ${pct(noEdits.filter((x) => x.t.shellWrites > 0).length, noEdits.length)} of ${noEdits.length}`,
    );
    console.log(`record build: p50 ${quantile(ms, 0.5).toFixed(1)}ms, p95 ${quantile(ms, 0.95).toFixed(1)}ms, max ${Math.max(...ms).toFixed(1)}ms`);

    // What attaching outcomes costs a search: warm once, then off and on.
    const qfile = join(root, "golden-pairs.json");
    if (existsSync(qfile)) {
      const qs = JSON.parse(readFileSync(qfile, "utf8")) as Mined[];
      const once = async (outcomes: boolean) => {
        const times: number[] = [];
        for (const q of qs) {
          const t = performance.now();
          // Every project: the mined queries' own projects may not exist in this corpus.
          await searchOnce(app, q.query, { project: "*", semantic: false, rerank: false, outcomes, maxResults: 5 });
          times.push(performance.now() - t);
        }
        return times;
      };
      await once(false);
      const off = await once(false);
      const on = await once(true);
      console.log(`search (${qs.length} mined queries, lexical): p50 off ${quantile(off, 0.5).toFixed(0)}ms / on ${quantile(on, 0.5).toFixed(0)}ms, p95 off ${quantile(off, 0.95).toFixed(0)}ms / on ${quantile(on, 0.95).toFixed(0)}ms`);
    }

    // Audit tasks, not sessions: a task is what a search hit is summarized by.
    const audit: object[] = [];
    for (const st of ["verified", "failing", "unverified", "no-edits"] as const) {
      for (const { r, t } of shuffle(tasks.filter((x) => x.t.status === st), seed).slice(0, perStatus)) {
        audit.push({ harness: r.harness, sessionId: r.sessionId, task: `${r.tasks.indexOf(t) + 1}/${r.tasks.length}`, ...t });
      }
    }
    const out = join(root, "outcome-audit.jsonl");
    writeFileSync(out, audit.map((r) => JSON.stringify(r)).join("\n") + "\n");
    console.log(`audit sample: ${audit.length} tasks -> ${out}`);
  } finally {
    await closeApp(app);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
