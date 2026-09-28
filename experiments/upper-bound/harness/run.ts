/**
 * Upper-bound experiment harness: runs agents on trap tasks under different arms,
 * grades each run with the task's hidden grader, and records metrics.
 *
 *   tsx experiments/upper-bound/harness/run.ts --tasks refresh-rotation --arms control,hand --reps 10
 *
 * Each run gets a fresh copy of the task repo in a temp directory outside this
 * repository, so the agent can't see the notes, the grader or the reference fixes.
 * See experiments/upper-bound/README.md for arms, options and the protocol.
 */
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseTrace, touchedPaths } from "./trace.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const KIT = join(ROOT, "kit");
const TASKS = join(ROOT, "tasks");

export interface Arm {
  id: string;
  /** inject: notes pushed on tool calls; noop: hook installed but silent; off: no hook */
  push: "inject" | "noop" | "off";
  /** expose the bifrost_at MCP tool and tell the agent to use it */
  pull: boolean;
  /** notes file name in tasks/<task>/notes/, without .json */
  notes?: string;
}

export const BUILTIN_ARMS: Record<string, Arm> = {
  none: { id: "none", push: "off", pull: false },
  control: { id: "control", push: "noop", pull: false },
  hand: { id: "hand", push: "inject", pull: false, notes: "hand" },
  wrong: { id: "wrong", push: "inject", pull: false, notes: "wrong" },
  "hand-pull": { id: "hand-pull", push: "noop", pull: true, notes: "hand" },
};

/** "gen:<file>" pushes tasks/<task>/notes/<file>.json; "pull:<file>" serves it over MCP only. */
export function resolveArm(spec: string): Arm {
  if (BUILTIN_ARMS[spec]) return BUILTIN_ARMS[spec];
  const [kind, file] = spec.split(":");
  if (kind === "gen" && file) return { id: spec, push: "inject", pull: false, notes: file };
  if (kind === "pull" && file) return { id: spec, push: "noop", pull: true, notes: file };
  throw new Error(`unknown arm "${spec}" (built-in: ${Object.keys(BUILTIN_ARMS).join(", ")}, or gen:<notes-file>, pull:<notes-file>)`);
}

export const PULL_INSTRUCTION =
  "This repository has Bifröst, a shared log of notes other agents left about its files. Before you edit a file, call the bifrost_at tool with the file's path and take its notes into account.";

export interface TaskSpec {
  id: string;
  title: string;
  prompt: string;
  repo: string;
  hidden: string;
  grade: { command: string[]; outcomeIntro?: string; labels?: Record<string, string> };
}

export interface RunOptions {
  agent: "claude" | "codex" | "opencode" | "command";
  model?: string;
  agentCmd?: string;
  budgetUsd?: number;
  timeoutMs: number;
  settingSources: string;
  extraArgs: string[];
  keep: boolean;
}

export interface RunResult {
  task: string;
  arm: string;
  rep: number;
  agent: string;
  model?: string;
  startedAt: string;
  durationMs: number;
  exitCode: number | null;
  timedOut: boolean;
  costUsd?: number;
  numTurns?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  toolCalls: number;
  pushDeliveries: number;
  notesShown: string[];
  pullCalls: number;
  readPaths: string[];
  grade: Record<string, unknown> | null;
  pass: boolean;
  trapHit: boolean;
  goal: boolean;
  /** Set when the agent failed before doing any work (auth, network, bad model name): not a data point. */
  invalid?: string;
  runDir: string;
}

export function loadTask(id: string): TaskSpec {
  return JSON.parse(readFileSync(join(TASKS, id, "task.json"), "utf8")) as TaskSpec;
}

function git(cwd: string, ...args: string[]) {
  const r = spawnSync("git", ["-c", "user.name=experiment", "-c", "user.email=experiment@localhost", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

export function prepareWorkspace(task: TaskSpec): string {
  const ws = mkdtempSync(join(tmpdir(), `bifrost-exp-${task.id}-`));
  cpSync(join(TASKS, task.id, task.repo), ws, { recursive: true });
  git(ws, "init", "-q");
  git(ws, "add", "-A");
  git(ws, "commit", "-q", "-m", "initial");
  return ws;
}

function hookSettings(): object {
  return {
    hooks: {
      PreToolUse: [
        {
          matcher: "Read|Edit|Write|MultiEdit|NotebookEdit|Grep|Glob|Bash",
          hooks: [{ type: "command", command: `node "${join(KIT, "hook.mjs")}"`, timeout: 10 }],
        },
      ],
    },
  };
}

export function buildAgentCommand(
  task: TaskSpec,
  arm: Arm,
  opts: RunOptions,
  paths: { ws: string; runDir: string; notesFile?: string; env: Record<string, string> },
): { cmd: string; args: string[]; shell: boolean } {
  const promptFile = join(paths.runDir, "prompt.txt");
  writeFileSync(promptFile, task.prompt);
  if (opts.agent === "command") {
    if (!opts.agentCmd) throw new Error("--agent command needs --agent-cmd");
    const cmd = opts.agentCmd.replaceAll("{workspace}", paths.ws).replaceAll("{promptFile}", promptFile).replaceAll("{runDir}", paths.runDir);
    return { cmd, args: [], shell: true };
  }
  const mcpServers: Record<string, unknown> = {};
  if (arm.pull) {
    mcpServers.bifrost = {
      command: "node",
      args: [join(KIT, "mcp-server.mjs")],
      env: { BIFROST_NOTES: paths.notesFile ?? "", BIFROST_LOG: paths.env.BIFROST_LOG, BIFROST_ROOT: paths.ws },
    };
  }
  if (opts.agent === "opencode") return openCodeCommand(task, arm, opts, paths);
  if (opts.agent === "claude") {
    const settingsFile = join(paths.runDir, "settings.json");
    writeFileSync(settingsFile, JSON.stringify(arm.push === "off" ? {} : hookSettings(), null, 2));
    const mcpFile = join(paths.runDir, "mcp.json");
    writeFileSync(mcpFile, JSON.stringify({ mcpServers }, null, 2));
    const args = [
      "-p", task.prompt,
      "--output-format", "stream-json", "--verbose",
      "--permission-mode", "bypassPermissions",
      "--settings", settingsFile,
      "--setting-sources", opts.settingSources,
      "--mcp-config", mcpFile, "--strict-mcp-config",
      "--no-session-persistence",
    ];
    if (opts.model) args.push("--model", opts.model);
    if (opts.budgetUsd) args.push("--max-budget-usd", String(opts.budgetUsd));
    if (arm.pull) args.push("--append-system-prompt", PULL_INSTRUCTION);
    args.push(...opts.extraArgs);
    return { cmd: "claude", args, shell: false };
  }
  // codex: unverified here. Push can't be injected (Codex Desktop rejects additionalContext on
  // PreToolUse, per Graphify's notes); pull goes through AGENTS.md plus an MCP server.
  if (arm.push === "inject") throw new Error(`arm ${arm.id} pushes notes, which the codex runner does not support; use a pull arm`);
  const args = ["exec", "--json", "--skip-git-repo-check", "--full-auto"];
  if (opts.model) args.push("-m", opts.model);
  if (arm.pull) {
    writeFileSync(join(paths.ws, "AGENTS.md"), `${PULL_INSTRUCTION}\n`);
    const env = mcpServers.bifrost as { env: Record<string, string> };
    args.push(
      "-c", `mcp_servers.bifrost.command="node"`,
      "-c", `mcp_servers.bifrost.args=[${JSON.stringify(join(KIT, "mcp-server.mjs"))}]`,
      "-c", `mcp_servers.bifrost.env={ ${Object.entries(env.env).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(", ")} }`,
    );
  }
  args.push(...opts.extraArgs, task.prompt);
  return { cmd: "codex", args, shell: false };
}

/**
 * OpenCode (`opencode run --format json`). Config goes in through OPENCODE_CONFIG_CONTENT,
 * merged over your own OpenCode config (providers, keys, default model), so nothing is
 * written into the workspace:
 *  - push arms load kit/opencode-plugin.mjs, which appends notes to tool results;
 *  - pull arms get the bifrost MCP server and the pull instruction as an instructions file;
 *  - edits and shell are allowed without prompts, files outside the workspace are denied.
 * OpenCode has no spending cap, so --budget-usd is ignored; --timeout-min still applies.
 */
function openCodeCommand(task: TaskSpec, arm: Arm, opts: RunOptions, paths: { ws: string; runDir: string; notesFile?: string; env: Record<string, string> }) {
  const config: Record<string, unknown> = {
    $schema: "https://opencode.ai/config.json",
    share: "disabled",
    autoupdate: false,
    permission: { edit: "allow", bash: "allow", webfetch: "allow", external_directory: "deny" },
  };
  if (arm.push !== "off") config.plugin = [pathToFileURL(join(KIT, "opencode-plugin.mjs")).href];
  if (arm.pull) {
    config.mcp = {
      bifrost: {
        type: "local",
        command: ["node", join(KIT, "mcp-server.mjs")],
        environment: { BIFROST_NOTES: paths.notesFile ?? "", BIFROST_LOG: paths.env.BIFROST_LOG, BIFROST_ROOT: paths.ws },
        enabled: true,
      },
    };
    const instructions = join(paths.runDir, "bifrost-instructions.md");
    writeFileSync(instructions, `${PULL_INSTRUCTION}\n`);
    config.instructions = [instructions];
  }
  // Read by runOne and passed to the agent's environment only.
  paths.env.OPENCODE_CONFIG_CONTENT = JSON.stringify(config);
  // Keep ~/.claude (CLAUDE.md, skills) out of the runs, as --setting-sources project does for Claude Code.
  paths.env.OPENCODE_DISABLE_CLAUDE_CODE = "1";
  paths.env.OPENCODE_DISABLE_AUTOUPDATE = "1";
  const args = ["run", "--format", "json", "--dir", paths.ws];
  if (opts.model) args.push("--model", opts.model);
  args.push(...opts.extraArgs, task.prompt);
  return { cmd: "opencode", args, shell: false };
}

function runProcess(cmd: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; shell: boolean; timeoutMs: number; stdoutFile: string; stderrFile: string }): Promise<{ code: number | null; timedOut: boolean }> {
  return new Promise((resolvePromise) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, shell: opts.shell, stdio: ["ignore", "pipe", "pipe"] });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    }, opts.timeoutMs);
    child.stdout.on("data", (d) => appendFileSync(opts.stdoutFile, d));
    child.stderr.on("data", (d) => appendFileSync(opts.stderrFile, d));
    child.on("error", (err) => {
      appendFileSync(opts.stderrFile, `spawn error: ${err.message}\n`);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code, timedOut });
    });
  });
}

export function grade(task: TaskSpec, ws: string): Record<string, unknown> | null {
  const grader = join(ws, ".grader");
  rmSync(grader, { recursive: true, force: true });
  cpSync(join(TASKS, task.id, task.hidden), grader, { recursive: true });
  const [cmd, ...args] = task.grade.command;
  const r = spawnSync(cmd, args, { cwd: ws, encoding: "utf8", timeout: 10 * 60_000 });
  const last = (r.stdout ?? "").trim().split("\n").pop() ?? "";
  try {
    return JSON.parse(last) as Record<string, unknown>;
  } catch {
    return { error: `grader output not JSON (exit ${r.status}): ${(r.stdout + r.stderr).slice(-2000)}` };
  }
}

/**
 * The graded outcome as plain text. It is appended to the trace, so a notes generator
 * sees what happened after the session, as a later test run or incident would show.
 */
export function outcomeText(g: Record<string, unknown> | null, spec?: TaskSpec["grade"]): string {
  if (!g) return "Not graded.";
  if (g.error) return `Grading failed: ${String(g.error)}`;
  const d = (g.details ?? {}) as Record<string, string>;
  const labels = spec?.labels ?? Object.fromEntries(Object.keys(g).filter((k) => typeof g[k] === "boolean" && k !== "pass" && k !== "trapHit").map((k) => [k, k]));
  const parts = Object.entries(labels).map(([k, label]) => `${label}: ${g[k] ? "yes" : `NO${d[k] ? ` (${d[k]})` : ""}`}.`);
  return [spec?.outcomeIntro ?? "After the session the change was graded.", ...parts].join(" ");
}

interface ClaudeResult {
  total_cost_usd?: number;
  num_turns?: number;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
}

interface OpenCodeStep {
  cost?: number;
  tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } };
}

/** OpenCode reports cost and tokens per step (`step_finish`), not once per run. */
function openCodeTotals(traceText: string): ClaudeResult | undefined {
  let steps = 0;
  const t = { cost: 0, input: 0, output: 0, read: 0, write: 0 };
  for (const line of traceText.split("\n")) {
    if (!line.includes("step_finish")) continue;
    try {
      const o = JSON.parse(line) as { type?: string; part?: OpenCodeStep };
      if (o.type !== "step_finish" || !o.part) continue;
      steps += 1;
      t.cost += o.part.cost ?? 0;
      t.input += o.part.tokens?.input ?? 0;
      t.output += (o.part.tokens?.output ?? 0) + (o.part.tokens?.reasoning ?? 0);
      t.read += o.part.tokens?.cache?.read ?? 0;
      t.write += o.part.tokens?.cache?.write ?? 0;
    } catch { /* ignore */ }
  }
  if (!steps) return undefined;
  return { total_cost_usd: t.cost, num_turns: steps, usage: { input_tokens: t.input, output_tokens: t.output, cache_read_input_tokens: t.read, cache_creation_input_tokens: t.write } };
}

export function metricsFromTrace(traceText: string, ws: string) {
  let result: ClaudeResult | undefined = openCodeTotals(traceText);
  for (const line of traceText.split("\n")) {
    if (!line.includes('"type":"result"') && !line.includes('"type": "result"')) continue;
    try {
      const o = JSON.parse(line) as { type?: string } & ClaudeResult;
      if (o.type === "result") result = o;
    } catch { /* ignore */ }
  }
  const steps = parseTrace(traceText);
  return {
    costUsd: result?.total_cost_usd,
    numTurns: result?.num_turns,
    inputTokens: result?.usage?.input_tokens,
    outputTokens: result?.usage?.output_tokens,
    cacheReadTokens: result?.usage?.cache_read_input_tokens,
    cacheWriteTokens: result?.usage?.cache_creation_input_tokens,
    toolCalls: steps.filter((s) => s.kind === "tool_call").length,
    readPaths: touchedPaths(steps, ws),
  };
}

/**
 * Why a run is not a data point, or undefined when it is. A run whose agent made no tool
 * call and exited with an error (or reported a fatal error event) never attempted the task.
 */
export function invalidReason(traceText: string, exitCode: number | null, toolCalls: number): string | undefined {
  if (toolCalls > 0) return undefined;
  for (const line of traceText.split("\n")) {
    if (!line.includes('"error"') && !line.includes('"is_error"')) continue;
    try {
      const o = JSON.parse(line) as { type?: string; is_error?: boolean; result?: string; error?: { name?: string; message?: string; data?: { message?: string } } };
      if (o.type === "error") return `agent error: ${o.error?.data?.message ?? o.error?.message ?? o.error?.name ?? "unknown"}`.slice(0, 300);
      if (o.type === "result" && o.is_error) return `agent error: ${String(o.result ?? "unknown")}`.slice(0, 300);
    } catch { /* ignore */ }
  }
  if (exitCode !== 0) return `agent exited with code ${exitCode} before any tool call`;
  return undefined;
}

export function deliveriesFrom(logFile: string) {
  const out = { pushDeliveries: 0, notesShown: new Set<string>(), pullCalls: 0 };
  if (!existsSync(logFile)) return { pushDeliveries: 0, notesShown: [] as string[], pullCalls: 0 };
  for (const line of readFileSync(logFile, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as { channel?: string; shown?: string[] };
      if (e.channel === "pull") out.pullCalls += 1;
      if (e.shown?.length) {
        if (e.channel === "push") out.pushDeliveries += 1;
        e.shown.forEach((id) => out.notesShown.add(id));
      }
    } catch { /* ignore */ }
  }
  return { pushDeliveries: out.pushDeliveries, notesShown: [...out.notesShown].sort(), pullCalls: out.pullCalls };
}

export async function runOne(task: TaskSpec, arm: Arm, rep: number, opts: RunOptions, outDir: string): Promise<RunResult> {
  const runDir = join(outDir, task.id, arm.id.replace(/[^A-Za-z0-9_.-]/g, "_"), `rep-${String(rep).padStart(2, "0")}`);
  rmSync(runDir, { recursive: true, force: true });
  mkdirSync(runDir, { recursive: true });
  const ws = prepareWorkspace(task);
  let notesFile: string | undefined;
  if (arm.notes) {
    const src = join(TASKS, task.id, "notes", `${arm.notes}.json`);
    if (!existsSync(src)) throw new Error(`notes file not found: ${src}`);
    notesFile = join(runDir, "notes.json");
    cpSync(src, notesFile);
  }
  const env: Record<string, string> = {
    BIFROST_MODE: arm.push === "inject" ? "inject" : "noop",
    BIFROST_LOG: join(runDir, "deliveries.jsonl"),
    BIFROST_STATE: join(runDir, "state"),
  };
  if (notesFile && arm.push === "inject") env.BIFROST_NOTES = notesFile;
  const { cmd, args, shell } = buildAgentCommand(task, arm, opts, { ws, runDir, notesFile, env });
  writeFileSync(join(runDir, "command.json"), JSON.stringify({ cmd, args, cwd: ws, env }, null, 2));

  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const traceFile = join(runDir, "trace.jsonl");
  writeFileSync(traceFile, "");
  const { code, timedOut } = await runProcess(cmd, args, {
    cwd: ws,
    env: { ...process.env, ...env },
    shell,
    timeoutMs: opts.timeoutMs,
    stdoutFile: traceFile,
    stderrFile: join(runDir, "agent.stderr.log"),
  });
  const durationMs = Date.now() - t0;

  writeFileSync(join(runDir, "diff.patch"), spawnSync("git", ["diff"], { cwd: ws, encoding: "utf8" }).stdout ?? "");
  const g = grade(task, ws);
  writeFileSync(join(runDir, "grade.json"), JSON.stringify(g, null, 2));
  appendFileSync(traceFile, JSON.stringify({ type: "bifrost.outcome", grade: g, text: outcomeText(g, task.grade) }) + "\n");

  const traceText = readFileSync(traceFile, "utf8");
  const metrics = metricsFromTrace(traceText, ws);
  const invalid = timedOut ? undefined : invalidReason(traceText, code, metrics.toolCalls);
  const result: RunResult = {
    task: task.id,
    arm: arm.id,
    rep,
    agent: opts.agent,
    model: opts.model,
    startedAt,
    durationMs,
    exitCode: code,
    timedOut,
    ...metrics,
    ...deliveriesFrom(env.BIFROST_LOG),
    grade: g,
    pass: g?.pass === true,
    trapHit: g?.trapHit === true,
    goal: g?.goal === true,
    ...(invalid ? { invalid } : {}),
    runDir,
  };
  writeFileSync(join(runDir, "result.json"), JSON.stringify(result, null, 2));
  if (!opts.keep) rmSync(ws, { recursive: true, force: true });
  else writeFileSync(join(runDir, "workspace.txt"), ws + "\n");
  return result;
}

async function pool<T>(items: (() => Promise<T>)[], size: number): Promise<T[]> {
  const results: T[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, size) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await items[i]();
      }
    }),
  );
  return results;
}

function arg(argv: string[], name: string, fallback?: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
}

function toolVersion(cmd: string): string | undefined {
  const r = spawnSync(cmd, ["--version"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : undefined;
}

async function main(argv: string[]) {
  const tasks = (arg(argv, "tasks") ?? "").split(",").filter(Boolean);
  const arms = (arg(argv, "arms") ?? "control,hand").split(",").filter(Boolean).map(resolveArm);
  if (tasks.length === 0) {
    console.error(`usage: run.ts --tasks <id,...> [--arms control,hand] [--reps 10] [--agent claude|opencode|codex|command] [--model M]
  [--budget-usd 3] [--timeout-min 20] [--concurrency 2] [--out <dir>] [--setting-sources project] [--keep]
  [--agent-cmd "<shell command with {workspace} {promptFile} {runDir}>"] [-- <extra agent args>]`);
    process.exit(2);
  }
  const dashdash = argv.indexOf("--");
  const opts: RunOptions = {
    agent: (arg(argv, "agent", "claude") as RunOptions["agent"]),
    model: arg(argv, "model"),
    agentCmd: arg(argv, "agent-cmd"),
    budgetUsd: arg(argv, "budget-usd") ? Number(arg(argv, "budget-usd")) : undefined,
    timeoutMs: Number(arg(argv, "timeout-min", "20")) * 60_000,
    settingSources: arg(argv, "setting-sources", "project") ?? "project",
    extraArgs: dashdash >= 0 ? argv.slice(dashdash + 1) : [],
    keep: argv.includes("--keep"),
  };
  const reps = Number(arg(argv, "reps", "10"));
  const concurrency = Number(arg(argv, "concurrency", "2"));
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = resolve(arg(argv, "out") ?? join(ROOT, "results", stamp));
  mkdirSync(outDir, { recursive: true });
  const specs = tasks.map(loadTask);

  writeFileSync(
    join(outDir, "manifest.json"),
    JSON.stringify(
      {
        startedAt: new Date().toISOString(),
        tasks,
        arms,
        reps,
        concurrency,
        opts: { ...opts, agentCmd: opts.agentCmd ? "(set)" : undefined },
        agentVersion: opts.agent === "command" ? undefined : toolVersion(opts.agent),
        node: process.version,
        repoCommit: spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).stdout.trim(),
      },
      null,
      2,
    ),
  );

  // Interleave arms and reps so drift over time (rate limits, model updates) hits all arms alike.
  const jobs: (() => Promise<RunResult>)[] = [];
  for (let rep = 1; rep <= reps; rep++)
    for (const task of specs)
      for (const arm of arms)
        jobs.push(async () => {
          const r = await runOne(task, arm, rep, opts, outDir);
          appendFileSync(join(outDir, "results.jsonl"), JSON.stringify(r) + "\n");
          const cost = r.costUsd !== undefined ? ` $${r.costUsd.toFixed(2)}` : "";
          console.log(`${task.id} ${arm.id} rep ${rep}: ${r.invalid ? "INVALID" : r.pass ? "PASS" : r.trapHit ? "TRAP" : "FAIL"} ${(r.durationMs / 1000).toFixed(0)}s${cost} notes=${r.notesShown.join("|") || "-"}${r.invalid ? ` (${r.invalid})` : ""}`);
          return r;
        });
  await pool(jobs, concurrency);
  console.log(`\nResults: ${join(outDir, "results.jsonl")}\nReport:  tsx experiments/upper-bound/harness/report.ts ${outDir}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
