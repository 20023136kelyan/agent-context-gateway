/**
 * Native Apple Silicon MLX Embedding Client (Phase D).
 * Runs BGE-small directly on the Apple Silicon GPU via Metal using an in-process Python worker.
 * Eliminates the external Ollama background daemon while yielding ~150-160 sentences/sec throughput.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

export const MLX_DIM = 384;
export const MLX_MODEL = "bge-small";

/** Wait this long for the ready line; after that requests are sent anyway (they queue on stdin during a slow first load). */
const READY_GRACE_MS = 8000;
/** After the worker dies, report unavailable (provider falls back) for this long instead of respawning per call. */
const FAILURE_COOLDOWN_MS = 60_000;
/** A request that takes longer means the worker is wedged: fail it and restart. */
const REQUEST_TIMEOUT_MS = 120_000;

function defaultPythonPath(): string {
  return join(homedir(), ".context-gateway", "mlx-venv", "bin", "python");
}

/** Resolved next to this module, not from process.cwd(): MCP servers and hooks start in other directories. */
function defaultWorkerScript(): string {
  const sibling = fileURLToPath(new URL("./mlx-worker.py", import.meta.url));
  if (existsSync(sibling)) return sibling;
  // Compiled dist/embeddings/mlx.js: tsc doesn't copy the .py; use the source tree's.
  return fileURLToPath(new URL("../../src/embeddings/mlx-worker.py", import.meta.url));
}

export interface MlxEmbedderOptions {
  pythonPath?: string;
  scriptPath?: string;
  requestTimeoutMs?: number;
}

interface PendingRequest {
  resolve: (res: number[][]) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export class MlxEmbedder {
  readonly pythonPath: string;
  readonly scriptPath: string;
  private readonly requestTimeoutMs: number;
  private child: ChildProcess | null = null;
  private starting: Promise<void> | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private cooldownUntil = 0;

  constructor(opts: MlxEmbedderOptions = {}) {
    this.pythonPath = opts.pythonPath ?? defaultPythonPath();
    this.scriptPath = opts.scriptPath ?? defaultWorkerScript();
    this.requestTimeoutMs = opts.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  async isAvailable(): Promise<boolean> {
    return Date.now() >= this.cooldownUntil && existsSync(this.pythonPath) && existsSync(this.scriptPath);
  }

  private ensureWorker(): Promise<void> {
    if (this.child) return this.starting ?? Promise.resolve();
    if (Date.now() < this.cooldownUntil) {
      return Promise.reject(new Error("MLX worker cooling down after a failure"));
    }
    const child = spawn(this.pythonPath, [this.scriptPath], { stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    child.unref();
    child.stdin?.on("error", () => {
      // EPIPE after the worker died — the close handler reports it.
    });

    createInterface({ input: child.stdout! }).on("line", (line) => {
      if (!line.trim()) return;
      try {
        const resp = JSON.parse(line) as { id?: number; embeddings?: number[][]; error?: string };
        const req = resp.id ? this.pending.get(resp.id) : undefined;
        if (!req || resp.id === undefined) return;
        this.pending.delete(resp.id);
        clearTimeout(req.timer);
        if (resp.error) req.reject(new Error(resp.error));
        else req.resolve(resp.embeddings ?? []);
      } catch {
        // ignore malformed worker output
      }
    });

    let stderrTail = "";
    this.starting = new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(grace);
        if (err) reject(err);
        else resolve();
      };
      const grace = setTimeout(() => settle(), READY_GRACE_MS);
      grace.unref?.();
      child.stderr?.on("data", (d: Buffer) => {
        const s = d.toString();
        stderrTail = (stderrTail + s).slice(-500);
        if (s.includes("MLX worker ready")) settle();
      });
      child.on("error", (e) => {
        const err = new Error(`MLX worker failed to spawn: ${e.message}`);
        this.onWorkerGone(child, err);
        settle(err);
      });
      // "close" (not "exit"): stderr is fully read, so the error carries the worker's last words.
      child.on("close", (code) => {
        const err = new Error(`MLX worker exited with code ${code}${stderrTail.trim() ? `: ${stderrTail.trim()}` : ""}`);
        this.onWorkerGone(child, err);
        settle(err);
      });
    });
    return this.starting;
  }

  /** Fail everything waiting on this worker and back off before the next spawn. */
  private onWorkerGone(child: ChildProcess, err: Error): void {
    if (this.child !== child) return; // already replaced or closed on purpose
    this.child = null;
    this.starting = null;
    this.cooldownUntil = Date.now() + FAILURE_COOLDOWN_MS;
    for (const req of this.pending.values()) {
      clearTimeout(req.timer);
      req.reject(err);
    }
    this.pending.clear();
  }

  async embedTexts(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    await this.ensureWorker();
    const child = this.child;
    if (!child?.stdin) throw new Error("MLX worker is not running");
    const id = this.nextId++;
    return new Promise<number[][]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MLX request timed out after ${this.requestTimeoutMs}ms`));
        // A wedged worker would stall every later request too.
        child.kill();
      }, this.requestTimeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      child.stdin!.write(JSON.stringify({ id, texts }) + "\n");
    });
  }

  async embedQuery(query: string): Promise<number[]> {
    const [vec] = await this.embedTexts([query]);
    return vec;
  }

  close(): void {
    const child = this.child;
    this.child = null;
    this.starting = null;
    if (!child) return;
    try {
      child.stdin?.end();
      child.kill();
    } catch {
      // ignore
    }
  }
}

let sharedMlxEmbedder: MlxEmbedder | null = null;

export function getSharedMlxEmbedder(): MlxEmbedder {
  if (!sharedMlxEmbedder) {
    sharedMlxEmbedder = new MlxEmbedder();
  }
  return sharedMlxEmbedder;
}
