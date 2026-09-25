#!/usr/bin/env node
/**
 * acg-bench: does searching earlier agent history make an agent faster,
 * cheaper, or more often right on real tasks?
 *
 *   npx tsx bench/cli.ts tasks    [--suite acg-self]
 *   npx tsx bench/cli.ts prepare  [--suite acg-self] [--refresh-history]
 *   npx tsx bench/cli.ts validate [--suite acg-self] [--tasks a,b]
 *   npx tsx bench/cli.ts run      --exp <name> [--suite acg-self] [--agent agy] [--model m]
 *                                 [--arms none,acg] [--tasks a,b] [--repeats 1] [--concurrency 3] [--rerun]
 *   npx tsx bench/cli.ts status   --exp <name>
 *   npx tsx bench/cli.ts report   --exp <name>
 *   npx tsx bench/cli.ts serve    [--port 4455]          (web view of every experiment, live)
 *   npx tsx bench/cli.ts export   --exp <name> --out report.html
 *
 * State lives in ~/.acg-bench (ACG_BENCH_HOME). See bench/README.md.
 */
import { Command } from "commander";
import { writeFileSync } from "node:fs";
import { checkSummary } from "./lib/check.js";
import { prepareGateway, prepareHistory, prepareDeps } from "./lib/prepare.js";
import { buildReport, printReport } from "./lib/report.js";
import { listRuns, runExperiment, ARMS } from "./lib/runner.js";
import { startServer, exportHtml } from "./lib/server.js";
import { loadSuite, pickTasks } from "./lib/suite.js";
import { validateTask } from "./lib/validate.js";
import { killAllChildren } from "./lib/util.js";

const list = (v: string) => v.split(",").map((s) => s.trim()).filter(Boolean);
const program = new Command("acg-bench").description("Task-outcome benchmark: agents with and without the gateway");

program
  .command("tasks")
  .option("--suite <name>", "suite", "acg-self")
  .action((o) => {
    const suite = loadSuite(o.suite);
    for (const t of suite.tasks) console.log(`${t.id.padEnd(24)} ${t.category.padEnd(14)} ${t.asOf}  ${t.title}`);
    console.log(`\narms: ${Object.entries(ARMS).map(([k, a]) => `${k} (${a.description})`).join("; ")}`);
  });

program
  .command("prepare")
  .option("--suite <name>", "suite", "acg-self")
  .option("--refresh-history", "re-copy the history snapshot (new sessions since)")
  .action(async (o) => {
    const suite = loadSuite(o.suite);
    const gw = prepareGateway();
    console.log(`gateway build ${gw.id} at ${gw.dir}`);
    const snap = await prepareHistory(suite, Boolean(o.refreshHistory));
    console.log(`history snapshot: ${snap.sessions} session file(s), taken ${snap.createdAt}`);
    for (const base of new Set(suite.tasks.map((t) => t.base))) console.log(`deps for ${base.slice(0, 7)}: ${prepareDeps(suite.repo, base)}`);
  });

program
  .command("validate")
  .description("Check each task: hidden tests fail at base and pass with the real change")
  .option("--suite <name>", "suite", "acg-self")
  .option("--tasks <ids>", "comma-separated task ids", list)
  .action(async (o) => {
    const suite = loadSuite(o.suite);
    let bad = 0;
    for (const t of pickTasks(suite, o.tasks)) {
      const v = await validateTask(suite, t);
      if (!v.ok) bad++;
      console.log(`${v.ok ? "ok  " : "BAD "} ${t.id.padEnd(24)} base: ${checkSummary(v.base)}; gold: ${checkSummary(v.gold)}`);
      if (!v.gold.passed) for (const f of v.gold.failures.slice(0, 3)) console.log(`       gold failure: ${f.test}: ${f.message.split("\n")[0]}`);
    }
    process.exitCode = bad ? 1 : 0;
  });

program
  .command("run")
  .requiredOption("--exp <name>", "experiment name (runs accumulate under it; done runs are skipped)")
  .option("--suite <name>", "suite", "acg-self")
  .option("--agent <name>", "agent under test", "agy")
  .option("--model <model>", "model (default: the agent's)")
  .option("--arms <arms>", "comma-separated arms", list)
  .option("--tasks <ids>", "comma-separated task ids", list)
  .option("--repeats <n>", "runs per task and arm", (v) => Number(v), 1)
  .option("--concurrency <n>", "runs at a time", (v) => Number(v), 3)
  .option("--rerun", "run again even where a run is done")
  .action(async (o) => {
    // Agents and gateways run in their own process groups: stop them with the bench.
    for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => (killAllChildren(), process.exit(130)));
    await runExperiment({ suite: o.suite, exp: o.exp, agent: o.agent, model: o.model, arms: o.arms, tasks: o.tasks, repeats: o.repeats, concurrency: o.concurrency, rerun: o.rerun });
    killAllChildren();
  });

program
  .command("status")
  .requiredOption("--exp <name>")
  .action((o) => {
    for (const r of listRuns(o.exp).sort((a, b) => a.runId.localeCompare(b.runId))) {
      const m = r.metrics;
      const live = r.status === "running" && r.live ? `${r.phase} ${Math.round(r.live.elapsedMs / 1000)}s, ${r.live.steps} steps, ${Math.round(r.live.tokens / 1000)}k tok, ${r.live.gatewayCalls} gateway` : r.phase ?? "";
      const result = r.status === "done" ? (r.check?.passed ? "PASS" : "FAIL") : r.status.toUpperCase();
      console.log(`${r.runId.padEnd(40)} ${result.padEnd(8)} ${m && r.status === "done" ? `${Math.round(m.wallMs / 1000)}s ${Math.round(m.tokens.total / 1000)}k tok ${m.toolCalls} tools ${r.gatewayServed ?? 0} gateway` : live}`);
    }
  });

program
  .command("report")
  .requiredOption("--exp <name>")
  .option("--json", "print the report as JSON")
  .action((o) => {
    const rep = buildReport(o.exp);
    if (o.json) console.log(JSON.stringify(rep, null, 2));
    else printReport(rep);
  });

program
  .command("serve")
  .option("--port <n>", "port", (v) => Number(v), 4455)
  .action(async (o) => {
    const url = await startServer(o.port);
    console.log(`acg-bench view on ${url} (Ctrl-C to stop)`);
  });

program
  .command("export")
  .requiredOption("--exp <name>")
  .requiredOption("--out <file>", "self-contained HTML file")
  .action((o) => {
    writeFileSync(o.out, exportHtml(o.exp));
    console.log(`wrote ${o.out}`);
  });

await program.parseAsync(process.argv);
