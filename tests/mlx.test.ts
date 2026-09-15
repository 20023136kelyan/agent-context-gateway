/**
 * Unit & integration tests for Native Apple Silicon MLX Embedding Sidecar (Phase D).
 */
import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getSharedMlxEmbedder, MlxEmbedder, MLX_DIM } from "../src/embeddings/mlx.js";
import { embeddingsAvailable, embedTexts, embedQuery } from "../src/embeddings/provider.js";
import { ClaudeAdapter } from "../src/adapters/claude.js";
import { VectorStore } from "../src/indexing/vectors.js";
import { embedSessionTurns } from "../src/indexing/embed-sync.js";

describe("MLX Embedding Engine (Apple Silicon GPU)", () => {
  it("detects MLX availability on this machine", async () => {
    const embedder = getSharedMlxEmbedder();
    const available = await embedder.isAvailable();
    expect(available).toBe(true);

    const status = await embeddingsAvailable();
    expect(status.available).toBe(true);
    expect(status.engine).toBe("mlx");
  });

  it("generates 384-dimensional dense vectors on Apple Silicon GPU", async () => {
    const texts = [
      "Session workbench remains private, files are the shared primitive",
      "How should teammates jointly edit together?",
    ];

    const embs = await embedTexts(texts);
    expect(embs.length).toBe(2);
    expect(embs[0].length).toBe(MLX_DIM);
    expect(embs[1].length).toBe(MLX_DIM);

    // Verify cosine similarity on paraphrase
    const dot = embs[0].reduce((acc, v, i) => acc + v * embs[1][i], 0);
    const normA = Math.sqrt(embs[0].reduce((acc, v) => acc + v * v, 0));
    const normB = Math.sqrt(embs[1].reduce((acc, v) => acc + v * v, 0));
    const cosSim = dot / (normA * normB);
    expect(cosSim).toBeGreaterThan(0.5);
  });

  it("embedQuery returns a single 384-dim vector", async () => {
    const vec = await embedQuery("collaboration workspace");
    expect(vec.length).toBe(MLX_DIM);
  });
});

describe("MLX worker resilience", () => {
  it("finds the worker script next to the module, whatever the cwd", async () => {
    const repoRoot = process.cwd();
    process.chdir(tmpdir());
    try {
      const embedder = new MlxEmbedder();
      expect(embedder.scriptPath).toBe(join(repoRoot, "src", "embeddings", "mlx-worker.py"));
      expect(await embedder.isAvailable()).toBe(true);
    } finally {
      process.chdir(repoRoot);
    }
  });

  it("a worker that dies at startup fails fast, then cools down instead of respawning", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acg-mlx-dead-"));
    const python = join(dir, "python");
    await writeFile(python, "#!/bin/sh\necho 'ModuleNotFoundError: mlx_embedding_models' >&2\nexit 1\n", { mode: 0o755 });
    const embedder = new MlxEmbedder({ pythonPath: python, scriptPath: python });
    const t0 = Date.now();
    await expect(embedder.embedTexts(["x"])).rejects.toThrow(/exited with code 1: ModuleNotFoundError/);
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(await embedder.isAvailable()).toBe(false);
    await expect(embedder.embedTexts(["x"])).rejects.toThrow(/cooling down/);
  });

  it("a wedged worker times out instead of hanging the caller", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acg-mlx-wedged-"));
    const python = join(dir, "python");
    await writeFile(python, "#!/bin/sh\necho 'MLX worker ready' >&2\nexec sleep 30\n", { mode: 0o755 });
    const embedder = new MlxEmbedder({ pythonPath: python, scriptPath: python, requestTimeoutMs: 300 });
    await expect(embedder.embedTexts(["x"])).rejects.toThrow(/timed out/);
  });
});

describe("vector backfill dedup", () => {
  it("checks the active engine's table, not whichever table exists first", async () => {
    const root = await mkdtemp(join(tmpdir(), "acg-vec-dedup-"));
    const claudeDir = join(root, "claude");
    const sid = "abababab-1111-2222-3333-444444444444";
    await mkdir(join(claudeDir, "p"), { recursive: true });
    await writeFile(
      join(claudeDir, "p", `${sid}.jsonl`),
      JSON.stringify({ type: "user", uuid: "u1", timestamp: "2026-09-10T10:00:00Z", sessionId: sid, cwd: "/repo/p", message: { role: "user", content: "legacy table dedup check" } }),
    );
    const adapter = new ClaudeAdapter(claudeDir);
    const [session] = await adapter.listSessions();
    const turns = await adapter.listTurns(sid);
    const vectors = await VectorStore.open(join(root, "vectors"));
    // An older 1024-dim model already embedded this turn into its own table.
    await vectors.upsert(
      turns.map((t) => ({ id: t.id, vector: new Array(1024).fill(0.01), harness: t.harness, sessionId: sid, projectId: "p", timestampMs: 0 })),
    );
    const res = await embedSessionTurns(adapter, session, vectors, 64, "mlx");
    expect(res.embedded).toBe(1);
    expect((await vectors.existing(turns.map((t) => t.id), MLX_DIM)).size).toBe(1);
  });
});
