/**
 * Runs an experiment: every task × arm × repeat, a few at a time, each in its
 * own sandboxed workspace. A run record (run.json) is rewritten as the run
 * moves, so `bench status` and the web view can follow it live; the agent's
 * timeline goes to events.jsonl as it happens.
 *
 * Arms differ only in what the agent gets:
 *   none      nothing: the repository and its git log
 *   acg       the gateway's MCP server, pinned to the task's moment
 *   acg-hint  the same, plus one workspace rule saying it is there and when to use it
 */
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AGENTS, type AgentEvent, type AgentRunResult, type Tokens } from "./agents.js";
import { runHiddenTests, type CheckResult } from "./check.js";
import { prepareDeps, prepareGateway, prepareHistory, cloneTree, type GatewayBuild, type HistorySnapshot } from "./prepare.js";
import { writeSandboxProfile } from "./sandbox.js";
import { loadSuite, pickTasks, type SuiteSpec, type TaskSpec } from "./suite.js";
import { BENCH_HOME, cleanEnv, ensureDir, readJson, run, trackChild, writeJson } from "./util.js";
import { captureDiff, createWorkspace, installHiddenTests } from "./workspace.js";

export interface ArmSpec {
  gateway: boolean;
  hint: boolean;
  description: string;
}

export const ARMS: Record<string, ArmSpec> = {
  none: { gateway: false, hint: false, description: "no gateway: the repository and its git log" },
  acg: { gateway: true, hint: false, description: "the gateway over MCP, pinned to the task's moment" },
  "acg-hint": { gateway: true, hint: true, description: "the gateway, plus a one-line rule saying it is there" },
};

/**
 * Said to the agent in every arm, before the task. agy in print mode ends the
 * run when its turn ends; in the pilot, agents started the tests in the
 * background, said they would wait, and ended with nothing done.
 */
export const PREAMBLE = `You are working on your own, non-interactively: nobody will read your messages or answer questions until you are done, and ending your turn ends the session. Run every command in the foreground and wait for it; do not start background tasks or timers. Finish the whole task, including running the relevant tests, before you end your turn.`;

/** Preamble, the suite's note on its test environment, then the task: the same for every arm. */
export const agentPrompt = (suite: SuiteSpec, task: TaskSpec) =>
  [PREAMBLE, suite.environmentNote ?? "", `Task:\n${task.prompt}`].filter(Boolean).join("\n\n");

/** The hint arm's one rule, written where the agent reads project instructions (the adapter decides where). */
export const HINT = `# Earlier sessions on this project

Earlier AI agent sessions on this project are searchable through the context
gateway's MCP tools (\`context.search\`, then \`context.get_context\` to read around
a hit). When a task continues or depends on earlier work (a decision, a
measurement, a bug seen before, the reason something is the way it is), search
them before exploring the code.
`;

export interface RunMetrics {
  wallMs: number;
  llmSteps: number;
  llmMs: number;
  tokens: Tokens & { total: number };
  toolCalls: number;
  toolMs: number;
  byTool: Record<string, number>;
  gatewayCalls: number;
  gatewayMs: number;
  editCalls: number;
  firstEditMs: number | null;
}

export interface RunRecord {
  exp: string;
  runId: string;
  taskId: string;
  arm: string;
  repeat: number;
  agent: string;
  model: string;
  status: "queued" | "running" | "done" | "error";
  phase?: "workspace" | "agent" | "check" | "done";
  startedAt?: string;
  finishedAt?: string;
  gatewayId?: string;
  /** In a gateway arm: did the agent get the gateway's tools, and how many calls did the gateway serve? */
  gatewayLoaded?: boolean;
  gatewayServed?: number;
  agentStatus?: string;
  /** What the agent itself reports the run cost, when it reports one (Claude Code). */
  costUsd?: number;
  timedOut?: boolean;
  finalText?: string;
  live?: { steps: number; tokens: number; toolCalls: number; gatewayCalls: number; elapsedMs: number };
  metrics?: RunMetrics;
  check?: CheckResult;
  diff?: { files: string[]; added: number; removed: number };
  /** Reads the sandbox refused (paths outside the workspace the agent tried). */
  refusedReads?: string[];
  error?: string;
}

export interface ExperimentSpec {
  exp: string;
  suite: string;
  agent: string;
  model: string;
  arms: string[];
  tasks: string[];
  repeats: number;
  concurrency: number;
  createdAt: string;
  gatewayId?: string;
  historyCreatedAt?: string;
}

export const expDir = (exp: string) => join(BENCH_HOME, "exps", exp);
export const runDir = (exp: string, runId: string) => join(expDir(exp), "runs", runId);

export function listRuns(exp: string): RunRecord[] {
  const dir = join(expDir(exp), "runs");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((id) => join(dir, id, "run.json"))
    .filter(existsSync)
    .map((p) => readJson<RunRecord>(p));
}

const withTotal = (t: Tokens): RunMetrics["tokens"] => ({ ...t, total: t.input + t.output + t.thinking });

export function summarize(events: AgentEvent[], wallMs: number): RunMetrics {
  const m: RunMetrics = {
    wallMs,
    llmSteps: 0,
    llmMs: 0,
    tokens: { input: 0, output: 0, thinking: 0, cacheRead: 0, total: 0 },
    toolCalls: 0,
    toolMs: 0,
    byTool: {},
    gatewayCalls: 0,
    gatewayMs: 0,
    editCalls: 0,
    firstEditMs: null,
  };
  for (const e of events) {
    if (e.kind === "llm") {
      m.llmSteps++;
      m.llmMs += e.durMs ?? 0;
      const t = e.tokens!;
      m.tokens.input += t.input;
      m.tokens.output += t.output;
      m.tokens.thinking += t.thinking;
      m.tokens.cacheRead += t.cacheRead;
      m.tokens.total += t.input + t.output + t.thinking;
    } else if (e.kind === "tool") {
      m.toolCalls++;
      m.toolMs += e.durMs ?? 0;
      m.byTool[e.name ?? "tool"] = (m.byTool[e.name ?? "tool"] ?? 0) + 1;
      if (e.gateway) {
        m.gatewayCalls++;
        m.gatewayMs += e.durMs ?? 0;
      }
      if (e.edit) {
        m.editCalls++;
        m.firstEditMs ??= e.t;
      }
    }
  }
  return m;
}

/** Start the pinned gateway for one run; resolves with its URL and a stop() that reports calls served. */
async function startGateway(gw: GatewayBuild, snap: HistorySnapshot, task: TaskSpec, dir: string, ws: string): Promise<{ url: string; stop: () => Promise<number> }> {
  const state = join(dir, "gateway-state");
  cloneTree(snap.state, state);
  const child: ChildProcess = spawn("node", [gw.entry], {
    detached: true,
    cwd: gw.dir,
    env: cleanEnv({ BENCH_STATE: state, BENCH_CLAUDE: snap.claude, BENCH_CODEX: snap.codex, BENCH_CWD: ws, GATEWAY_AS_OF: task.asOf }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const untrack = trackChild(child.pid);
  child.on("exit", untrack);
  let out = "";
  child.stdout!.on("data", (d: Buffer) => (out += d.toString()));
  child.stderr!.on("data", (d: Buffer) => appendFileSync(join(dir, "gateway.log"), d));
  const kill = () => {
    try {
      process.kill(-child.pid!, "SIGKILL");
    } catch {}
  };
  const port = await new Promise<number>((resolve, reject) => {
    // Generous: other runs' workspaces are built synchronously and can hold the event loop.
    // A gateway that misses it is killed, or it outlives the run and keeps the runner from exiting.
    const timer = setTimeout(() => (kill(), reject(new Error("gateway did not start in 180s"))), 180_000);
    const poll = setInterval(() => {
      const m = /"port":(\d+)/.exec(out);
      if (m) {
        clearInterval(poll);
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    }, 100);
    child.on("exit", (code) => reject(new Error(`gateway exited (${code}) before listening`)));
  });
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    stop: () =>
      new Promise<number>((resolve) => {
        child.on("exit", () => resolve(Number(/"calls":(\d+)/.exec(out)?.[1] ?? -1)));
        child.kill("SIGTERM");
        setTimeout(() => resolve(Number(/"calls":(\d+)/.exec(out)?.[1] ?? -1)), 5000);
      }),
  };
}

const REFUSED = /(?:Operation not permitted|operation not permitted)[^\n]*/g;

async function runOne(
  suite: SuiteSpec,
  task: TaskSpec,
  spec: ExperimentSpec,
  armName: string,
  repeat: number,
  gw: GatewayBuild,
  snap: HistorySnapshot,
): Promise<RunRecord> {
  const arm = ARMS[armName]!;
  const agent = AGENTS[spec.agent]!;
  const runId = `${task.id}__${armName}__r${repeat}`;
  const dir = runDir(spec.exp, runId);
  rmSync(dir, { recursive: true, force: true });
  ensureDir(dir);
  const rec: RunRecord = {
    exp: spec.exp, runId, taskId: task.id, arm: armName, repeat, agent: agent.name, model: spec.model,
    status: "running", phase: "workspace", startedAt: new Date().toISOString(), gatewayId: gw.id,
  };
  const save = () => writeJson(join(dir, "run.json"), rec);
  save();
  let gateway: Awaited<ReturnType<typeof startGateway>> | null = null;
  const events: AgentEvent[] = [];
  try {
    const ws = createWorkspace(suite, task, dir, prepareDeps(suite.repo, task.base));
    if (arm.gateway) {
      gateway = await startGateway(gw, snap, task, dir, ws);
    }
    const workDir = join(dir, "work");
    agent.prepare({ ws, workDir, gatewayUrl: gateway?.url ?? null, hint: arm.hint ? HINT : null });
    const profile = writeSandboxProfile(join(dir, "sandbox.sb"), workDir, agent.name);
    rec.phase = "agent";
    save();
    const t0 = Date.now();
    let lastSave = 0;
    const res: AgentRunResult = await agent.run({
      ws,
      workDir,
      prompt: agentPrompt(suite, task),
      model: spec.model,
      wrap: ["sandbox-exec", "-f", profile],
      gatewayUrl: gateway?.url ?? null,
      timeoutMs: (task.timeoutMin ?? 30) * 60_000,
      rawPath: join(dir, "raw.jsonl"),
      onEvent: (e) => {
        events.push(e);
        appendFileSync(join(dir, "events.jsonl"), JSON.stringify(e) + "\n");
        if (Date.now() - lastSave > 1500) {
          const m = summarize(events, Date.now() - t0);
          rec.live = { steps: m.llmSteps, tokens: m.tokens.total, toolCalls: m.toolCalls, gatewayCalls: m.gatewayCalls, elapsedMs: Date.now() - t0 };
          save();
          lastSave = Date.now();
        }
      },
    });
    rec.gatewayServed = gateway ? await gateway.stop() : undefined;
    gateway = null;
    rec.gatewayLoaded = arm.gateway ? res.toolsAvailable.some((t) => agent.isGatewayTool(t)) : undefined;
    rec.costUsd = res.costUsd;
    rec.agentStatus = res.status;
    rec.timedOut = res.timedOut;
    rec.finalText = res.finalText.slice(0, 20_000);
    rec.metrics = summarize(events, res.wallMs);
    if (res.totals) rec.metrics.tokens = withTotal(res.totals);
    rec.refusedReads = [...new Set(events.flatMap((e) => (e.output ?? "").match(REFUSED) ?? []))].slice(0, 30);
    if (res.stderr.trim()) writeFileSync(join(dir, "agent.stderr"), res.stderr);
    if (res.apiError) throw new Error(`agent API error (not a task result; rerun it): ${res.apiError}`);
    rec.phase = "check";
    save();
    const diff = captureDiff(ws, task.base);
    writeFileSync(join(dir, "diff.patch"), diff.patch);
    rec.diff = { files: diff.files, added: diff.added, removed: diff.removed };
    installHiddenTests(suite, task, ws);
    rec.check = await runHiddenTests(task, ws, join(dir, "tests.json"), ["sandbox-exec", "-f", profile]);
    rec.status = "done";
    rec.phase = "done";
  } catch (e) {
    rec.status = "error";
    rec.error = (e as Error).stack?.slice(0, 4000) ?? String(e);
    if (events.length && !rec.metrics) rec.metrics = summarize(events, events[events.length - 1]!.t);
  } finally {
    if (gateway) await gateway.stop();
    rec.finishedAt = new Date().toISOString();
    save();
    // Keep the record, timeline and diff; drop the heavy parts.
    rmSync(join(dir, "work"), { recursive: true, force: true });
    rmSync(join(dir, "gateway-state"), { recursive: true, force: true });
  }
  return rec;
}

/** Deterministic shuffle, so arms of one task are not always run in the same order. */
function shuffle<T>(xs: T[], seed: number): T[] {
  const a = [...xs];
  let s = seed || 1;
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const j = s % (i + 1);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

export async function runExperiment(opts: {
  suite: string;
  exp: string;
  agent?: string;
  model?: string;
  arms?: string[];
  tasks?: string[];
  repeats?: number;
  concurrency?: number;
  rerun?: boolean;
  log?: (s: string) => void;
}): Promise<void> {
  const log = opts.log ?? ((s: string) => console.log(s));
  const suite = loadSuite(opts.suite);
  const agentName = opts.agent ?? "agy";
  const agent = AGENTS[agentName];
  if (!agent) throw new Error(`unknown agent "${agentName}" (have: ${Object.keys(AGENTS).join(", ")})`);
  const arms = opts.arms ?? ["none", "acg"];
  for (const a of arms) if (!ARMS[a]) throw new Error(`unknown arm "${a}" (have: ${Object.keys(ARMS).join(", ")})`);
  const tasks = pickTasks(suite, opts.tasks);
  const manifestPath = join(expDir(opts.exp), "exp.json");
  const prev = existsSync(manifestPath) ? readJson<ExperimentSpec>(manifestPath) : null;
  const spec: ExperimentSpec = {
    exp: opts.exp,
    suite: suite.name,
    agent: agentName,
    model: opts.model ?? prev?.model ?? agent.defaultModel,
    arms: [...new Set([...(prev?.arms ?? []), ...arms])],
    tasks: [...new Set([...(prev?.tasks ?? []), ...tasks.map((t) => t.id)])],
    repeats: Math.max(prev?.repeats ?? 0, opts.repeats ?? 1),
    concurrency: opts.concurrency ?? 3,
    createdAt: prev?.createdAt ?? new Date().toISOString(),
  };
  log(`preparing gateway build and history snapshot for ${suite.name}...`);
  const gw = prepareGateway();
  const snap = await prepareHistory(suite);
  spec.gatewayId = gw.id;
  spec.historyCreatedAt = snap.createdAt;
  writeJson(manifestPath, spec);

  const done = new Set(listRuns(opts.exp).filter((r) => r.status === "done").map((r) => r.runId));
  const jobs: { task: TaskSpec; arm: string; repeat: number }[] = [];
  for (let repeat = 1; repeat <= (opts.repeats ?? 1); repeat++) {
    for (const task of shuffle(tasks, repeat * 7919)) {
      for (const arm of shuffle(arms, repeat * 31 + task.id.length)) {
        const runId = `${task.id}__${arm}__r${repeat}`;
        if (!opts.rerun && done.has(runId)) continue;
        jobs.push({ task, arm, repeat });
        const rec: RunRecord = { exp: opts.exp, runId, taskId: task.id, arm, repeat, agent: agentName, model: spec.model, status: "queued" };
        if (!existsSync(join(runDir(opts.exp, runId), "run.json")) || opts.rerun) writeJson(join(runDir(opts.exp, runId), "run.json"), rec);
      }
    }
  }
  log(`${jobs.length} run(s) to do (${done.size} already done), ${spec.concurrency} at a time`);
  let next = 0;
  let finished = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const j = jobs[next++]!;
      const r = await runOne(suite, j.task, spec, j.arm, j.repeat, gw, snap);
      finished++;
      const m = r.metrics;
      log(
        `[${finished}/${jobs.length}] ${r.runId}: ${r.status === "error" ? `ERROR ${r.error?.split("\n")[0]}` : r.check?.passed ? "PASS" : "FAIL"}` +
          (m ? ` ${Math.round(m.wallMs / 1000)}s ${Math.round(m.tokens.total / 1000)}k tok ${m.toolCalls} tools${r.gatewayServed ? `, ${r.gatewayServed} gateway` : ""}` : ""),
      );
      // A usage limit fails every run after it in seconds: stop, and let the same command resume later.
      if (r.error?.includes("agent API error") && next < jobs.length) {
        log(`stopping: the agent's API refused a run; ${jobs.length - next} run(s) not started. Run the same command again to resume.`);
        next = jobs.length;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, spec.concurrency) }, worker));
}

export { run };
