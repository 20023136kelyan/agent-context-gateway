/**
 * What every run shares, built once per suite:
 *
 * - the gateway under test: this checkout's build, copied to a neutral path
 *   (an agent can read its MCP config, and a path into this checkout would
 *   lead it to commits after its task), with an MCP entry point that reads
 *   only the suite's history snapshot;
 * - the history snapshot: the suite's agent history, copied and frozen, with
 *   its index built once (each run clones the index, so runs never share a
 *   writer);
 * - dependencies: node_modules per distinct lockfile, installed once and
 *   cloned into each workspace (copy-on-write on APFS).
 */
import { cpSync, existsSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { BENCH_HOME, REPO_ROOT, ensureDir, readJson, sh, sha, writeJson } from "./util.js";
import type { SuiteSpec } from "./suite.js";

/** Copy a tree, cloning files copy-on-write where the filesystem can (APFS), else copying. */
export function cloneTree(from: string, to: string): void {
  const r = sh("cp", ["-c", "-R", from, to], { allowFail: true });
  void r;
  if (!existsSync(to)) cpSync(from, to, { recursive: true });
}

// ---------------------------------------------------------------- gateway

export interface GatewayBuild {
  id: string;
  dir: string;
  entry: string;
}

const MCP_ENTRY = `// Written by bench/lib/prepare.ts: the gateway's MCP server over one frozen
// history, served over streamable HTTP on loopback. It runs outside the
// agent's sandbox, so the agent reaches history only through what it returns.
import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createApp } from "./dist/app.js";
import { buildMcpServer } from "./dist/transports/mcp.js";

const env = process.env;
const state = env.BENCH_STATE;
const deadEnd = (name) => {
  const d = join(state, name);
  mkdirSync(d, { recursive: true });
  return d;
};
env.CONTEXT_GATEWAY_STATE = state;
const app = createApp({
  stateDir: state,
  indexDir: join(state, "index"),
  claudeDir: env.BENCH_CLAUDE,
  codexDir: env.BENCH_CODEX,
  cursorDb: deadEnd("empty-cursor"),
  zepDir: deadEnd("empty-zep"),
  opencodeDb: deadEnd("empty-opencode"),
  trajectoryDir: deadEnd("empty-trajectories"),
  gitRepos: [],
});
const cwd = env.BENCH_CWD || process.cwd();
let calls = 0;
const http = createServer(async (req, res) => {
  if (!req.url?.startsWith("/mcp")) return void res.writeHead(404).end();
  if (req.method !== "POST") return void res.writeHead(405).end();
  let raw = "";
  for await (const chunk of req) raw += chunk;
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return void res.writeHead(400).end();
  }
  for (const m of Array.isArray(body) ? body : [body]) if (m?.method === "tools/call") calls++;
  // Stateless: a server and transport per request, over the one app.
  const server = buildMcpServer(app, cwd);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
});
http.listen(0, "127.0.0.1", () => console.log(JSON.stringify({ port: http.address().port })));
const stop = () => {
  console.log(JSON.stringify({ calls }));
  http.close();
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
`;

/** Build this checkout and copy the build where agents may see its path. */
export function prepareGateway(): GatewayBuild {
  sh("npm", ["run", "build", "--silent"], { cwd: REPO_ROOT });
  const head = sh("git", ["rev-parse", "--short", "HEAD"], { cwd: REPO_ROOT }).trim();
  const dirty = sh("git", ["status", "--porcelain", "--", "src"], { cwd: REPO_ROOT }).trim();
  const id = dirty ? `${head}-${sha(sh("git", ["diff", "HEAD", "--", "src"], { cwd: REPO_ROOT }), 6)}` : head;
  const dir = join(BENCH_HOME, "gateway", id);
  if (!existsSync(join(dir, "bench-mcp.mjs"))) {
    rmSync(dir, { recursive: true, force: true });
    ensureDir(dir);
    cloneTree(join(REPO_ROOT, "dist"), join(dir, "dist"));
    cloneTree(join(REPO_ROOT, "node_modules"), join(dir, "node_modules"));
    cpSync(join(REPO_ROOT, "package.json"), join(dir, "package.json"));
  }
  writeFileSync(join(dir, "bench-mcp.mjs"), MCP_ENTRY);
  return { id, dir, entry: join(dir, "bench-mcp.mjs") };
}

// ---------------------------------------------------------------- history

export interface HistorySnapshot {
  dir: string;
  claude: string;
  codex: string;
  state: string;
  createdAt: string;
  sessions: number;
}

export function historyDir(suite: SuiteSpec): string {
  return join(BENCH_HOME, "history", suite.name);
}

/** Copy the suite's history and index it once. `refresh` re-copies (new sessions since). */
export async function prepareHistory(suite: SuiteSpec, refresh = false): Promise<HistorySnapshot> {
  const dir = historyDir(suite);
  const manifestPath = join(dir, "manifest.json");
  if (!refresh && existsSync(manifestPath)) return readJson<HistorySnapshot>(manifestPath);
  rmSync(dir, { recursive: true, force: true });
  const claude = ensureDir(join(dir, "claude"));
  const codex = ensureDir(join(dir, "codex"));
  let sessions = 0;
  for (const src of suite.history.claude ?? []) {
    const to = ensureDir(join(claude, basename(src)));
    for (const name of readdirSync(src)) {
      if (name === "memory") continue; // notes, not history
      const from = join(src, name);
      if (name.endsWith(".jsonl")) sessions++;
      if (name.endsWith(".jsonl") || statSync(from).isDirectory()) cloneTree(from, join(to, name));
    }
  }
  for (const src of suite.history.codex ?? []) cloneTree(src, join(codex, basename(src)));
  const state = ensureDir(join(dir, "state"));
  // Index with this checkout's own code: the same code the gateway build runs.
  const { createApp, closeApp } = await import("../../src/app.js");
  const { syncNow } = await import("../../src/commands.js");
  const deadEnd = (n: string) => ensureDir(join(state, n));
  const prev = process.env.CONTEXT_GATEWAY_STATE;
  process.env.CONTEXT_GATEWAY_STATE = state;
  const app = createApp({
    stateDir: state,
    indexDir: join(state, "index"),
    claudeDir: claude,
    codexDir: codex,
    cursorDb: deadEnd("empty-cursor"),
    zepDir: deadEnd("empty-zep"),
    opencodeDb: deadEnd("empty-opencode"),
    trajectoryDir: deadEnd("empty-trajectories"),
    gitRepos: [],
  });
  try {
    await syncNow(app);
  } finally {
    closeApp(app);
    if (prev === undefined) delete process.env.CONTEXT_GATEWAY_STATE;
    else process.env.CONTEXT_GATEWAY_STATE = prev;
  }
  const snap: HistorySnapshot = { dir, claude, codex, state, createdAt: new Date().toISOString(), sessions };
  writeJson(manifestPath, snap);
  return snap;
}

// ---------------------------------------------------------------- dependencies

/** node_modules for the lockfile at `commit`: keyed by the resolved packages, so a version bump reuses it. */
export function prepareDeps(repo: string, commit: string): string {
  const lockText = sh("git", ["show", `${commit}:package-lock.json`], { cwd: repo });
  const lock = JSON.parse(lockText) as { packages?: Record<string, unknown> };
  const packages = { ...(lock.packages ?? {}) };
  delete packages[""];
  const key = sha(JSON.stringify(packages));
  const dir = join(BENCH_HOME, "deps", key);
  if (existsSync(join(dir, "node_modules"))) return join(dir, "node_modules");
  ensureDir(dir);
  // This checkout's own install serves when it resolves the same packages.
  const here = JSON.parse(sh("cat", [join(REPO_ROOT, "package-lock.json")])) as { packages?: Record<string, unknown> };
  const herePackages = { ...(here.packages ?? {}) };
  delete herePackages[""];
  if (sha(JSON.stringify(herePackages)) === key && existsSync(join(REPO_ROOT, "node_modules"))) {
    cloneTree(join(REPO_ROOT, "node_modules"), join(dir, "node_modules"));
  } else {
    writeFileSync(join(dir, "package.json"), sh("git", ["show", `${commit}:package.json`], { cwd: repo }));
    writeFileSync(join(dir, "package-lock.json"), lockText);
    sh("npm", ["ci", "--no-audit", "--no-fund", "--loglevel=error"], { cwd: dir });
  }
  return join(dir, "node_modules");
}
