/**
 * Native Apple Silicon MLX Embedding Client (Phase D).
 * Runs BGE-small directly on the Apple Silicon GPU via Metal using an in-process Python worker.
 * Eliminates the external Ollama background daemon while yielding ~150-160 sentences/sec throughput.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline";

export const MLX_DIM = 384;
export const MLX_MODEL = "bge-small";

function venvPythonPath(): string {
  return join(homedir(), ".context-gateway", "mlx-venv", "bin", "python");
}

function workerScriptPath(): string {
  return join(process.cwd(), "src", "embeddings", "mlx-worker.py");
}

export class MlxEmbedder {
  private child: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (res: number[][]) => void; reject: (err: Error) => void }>();
  private readyPromise: Promise<boolean> | null = null;

  async isAvailable(): Promise<boolean> {
    const py = venvPythonPath();
    const script = workerScriptPath();
    return existsSync(py) && existsSync(script);
  }

  private async ensureWorker(): Promise<void> {
    if (this.child && !this.child.killed) return;
    if (this.readyPromise) {
      await this.readyPromise;
      return;
    }

    this.readyPromise = new Promise<boolean>((resolve, reject) => {
      const py = venvPythonPath();
      const script = workerScriptPath();

      if (!existsSync(py)) {
        reject(new Error(`MLX Python venv not found at ${py}`));
        return;
      }

      this.child = spawn(py, [script], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.child.unref();

      const rl = createInterface({ input: this.child.stdout! });
      rl.on("line", (line) => {
        if (!line.trim()) return;
        try {
          const resp = JSON.parse(line) as { id?: number; embeddings?: number[][]; error?: string };
          if (resp.id && this.pending.has(resp.id)) {
            const { resolve: res, reject: rej } = this.pending.get(resp.id)!;
            this.pending.delete(resp.id);
            if (resp.error) rej(new Error(resp.error));
            else res(resp.embeddings ?? []);
          }
        } catch {
          // ignore malformed worker output
        }
      });

      this.child.stderr?.on("data", (d) => {
        const str = d.toString();
        if (str.includes("MLX worker ready")) {
          resolve(true);
        }
      });

      this.child.on("exit", (code) => {
        this.child = null;
        this.readyPromise = null;
        for (const { reject: rej } of this.pending.values()) {
          rej(new Error(`MLX worker exited with code ${code}`));
        }
        this.pending.clear();
      });

      // Fallback timeout for ready handshake
      setTimeout(() => resolve(true), 8000);
    });

    await this.readyPromise;
  }

  async embedTexts(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    await this.ensureWorker();

    const id = this.nextId++;
    return new Promise<number[][]>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const req = JSON.stringify({ id, texts }) + "\n";
      this.child!.stdin!.write(req);
    });
  }

  async embedQuery(query: string): Promise<number[]> {
    const [vec] = await this.embedTexts([query]);
    return vec;
  }

  close(): void {
    if (this.child) {
      try {
        this.child.stdin?.end();
        this.child.kill();
      } catch {
        // ignore
      }
      this.child = null;
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
