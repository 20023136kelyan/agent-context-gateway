/**
 * Shared plumbing: where the bench keeps its state, and small process helpers.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Everything the bench writes lives here, outside any repo: ACG_BENCH_HOME or ~/.acg-bench. */
export const BENCH_HOME = resolve(process.env.ACG_BENCH_HOME ?? join(homedir(), ".acg-bench"));
/** The checkout this bench code lives in (the gateway build under test comes from here). */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const expandHome = (p: string) => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

export function ensureDir(p: string): string {
  mkdirSync(p, { recursive: true });
  return p;
}

export function readJson<T>(path: string, fallback?: T): T {
  if (!existsSync(path)) {
    if (fallback !== undefined) return fallback;
    throw new Error(`missing ${path}`);
  }
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function writeJson(path: string, data: unknown): void {
  ensureDir(dirname(path));
  writeFileSync(path, JSON.stringify(data, null, 2));
}

export const sha = (s: string, n = 12) => createHash("sha256").update(s).digest("hex").slice(0, n);

/** Run a command to completion; throws with its stderr when it fails. */
export function sh(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string; allowFail?: boolean } = {}): string {
  const r = spawnSync(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env, input: opts.input, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0 && !opts.allowFail) {
    throw new Error(`${cmd} ${args.join(" ")} failed (${r.status}): ${(r.stderr || r.stdout || "").slice(0, 2000)}`);
  }
  return r.stdout ?? "";
}

/** Process groups started by run() and still alive: stopped together when the bench is interrupted. */
const liveGroups = new Set<number>();
export function trackChild(pid: number | undefined): () => void {
  if (!pid) return () => {};
  liveGroups.add(pid);
  return () => liveGroups.delete(pid);
}
export function killAllChildren(): void {
  for (const pid of liveGroups) {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // gone
      }
    }
  }
  liveGroups.clear();
}

/** Run a command with a time limit, streaming nothing; resolves with its exit code and output. */
export function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; stdinNull?: boolean; onStdoutLine?: (line: string) => void } = {},
): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean; ms: number }> {
  return new Promise((done) => {
    const t0 = Date.now();
    const p = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env, detached: true, stdio: [opts.stdinNull ? "ignore" : "pipe", "pipe", "pipe"] });
    const untrack = trackChild(p.pid);
    let stdout = "";
    let stderr = "";
    let pending = "";
    let timedOut = false;
    p.stdout!.on("data", (d: Buffer) => {
      const s = d.toString();
      stdout += s;
      if (opts.onStdoutLine) {
        pending += s;
        let i: number;
        while ((i = pending.indexOf("\n")) >= 0) {
          opts.onStdoutLine(pending.slice(0, i));
          pending = pending.slice(i + 1);
        }
      }
    });
    p.stderr!.on("data", (d: Buffer) => (stderr += d.toString()));
    // The whole process group: an agent's own children (test runners, MCP servers) go too.
    const kill = () => {
      try {
        if (p.pid) process.kill(-p.pid, "SIGTERM");
      } catch {
        // already gone
      }
    };
    const timer = opts.timeoutMs ? setTimeout(() => ((timedOut = true), kill()), opts.timeoutMs) : null;
    p.on("close", (code) => {
      untrack();
      if (timer) clearTimeout(timer);
      if (pending && opts.onStdoutLine) opts.onStdoutLine(pending);
      done({ code, stdout, stderr, timedOut, ms: Date.now() - t0 });
    });
    p.on("error", (e) => {
      if (timer) clearTimeout(timer);
      done({ code: -1, stdout, stderr: stderr + String(e), timedOut, ms: Date.now() - t0 });
    });
  });
}

/** Environment for agents and their tools: no gateway settings or vendor keys leak in from this process. */
export function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(GATEWAY_|CONTEXT_GATEWAY_|VOYAGE_|TYPESAFE_|JEV_|ACG_)/.test(k)) continue;
    env[k] = v;
  }
  return { ...env, ...extra };
}

export const median = (xs: number[]) => {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
