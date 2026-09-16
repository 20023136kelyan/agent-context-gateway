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

/**
 * BGE is trained for asymmetric retrieval: passages are embedded bare, queries
 * carry this instruction. Embedding a question like a passage puts it in the
 * wrong region of the space, which is why hybrid search ranked below lexical.
 * Stored vectors are unprefixed, so this needs no re-embedding of the corpus.
 *
 * Measured on the golden set (24 queries, corpus pinned to 2026-09-14):
 * hybrid NDCG@5 0.780 -> 0.818, paraphrase 0.538 -> 0.596, P@1 0.667 -> 0.708;
 * 4 queries better, 1 worse. It does NOT close the gap to lexical-only
 * (0.854 on the same pinned corpus): vectors still cost quality on this set,
 * and the prefix only makes them cost less. See the plan's open observations.
 */
export const BGE_QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";

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
    (child.stdin as unknown as { unref?: () => void } | null)?.unref?.();
    this.setBusy(child, true); // a caller is awaiting startup
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
        if (this.pending.size === 0) this.setBusy(child, false);
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
        if (this.pending.size === 0) this.setBusy(child, false);
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

  /**
   * An idle worker must not keep the process alive (a CLI or script that
   * embedded once would never exit); a busy one must, since a caller awaits it.
   */
  private setBusy(child: ChildProcess, busy: boolean): void {
    for (const stream of [child.stdout, child.stderr] as unknown as ({ ref?: () => void; unref?: () => void } | null)[]) {
      if (busy) stream?.ref?.();
      else stream?.unref?.();
    }
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
      this.setBusy(child, true);
      child.stdin!.write(JSON.stringify({ id, texts }) + "\n");
    });
  }

  async embedQuery(query: string): Promise<number[]> {
    const [vec] = await this.embedTexts([BGE_QUERY_PREFIX + query]);
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
