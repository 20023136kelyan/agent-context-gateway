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
import { chunkForEmbedding, EMBED_CHUNK_CHARS } from "../src/adapters/text.js";
import { embedChunkId, chunkTurnId } from "../src/core/id.js";
import { VectorStore } from "../src/indexing/vectors.js";
import { embedSessionTurns } from "../src/indexing/embed-sync.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import * as lancedb from "@lancedb/lancedb";

const execFileAsync = promisify(execFile);

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

  it("an idle worker doesn't keep the process alive after embedding", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acg-mlx-exit-"));
    const fakeWorker = join(dir, "python");
    await writeFile(
      fakeWorker,
      [
        "#!/usr/bin/env node",
        'process.stderr.write("MLX worker ready\\n");',
        'require("readline").createInterface({ input: process.stdin }).on("line", (l) => {',
        "  const { id, texts } = JSON.parse(l);",
        '  process.stdout.write(JSON.stringify({ id, embeddings: texts.map(() => [0.5]) }) + "\\n");',
        "});",
      ].join("\n"),
      { mode: 0o755 },
    );
    const script = join(dir, "embed-once.mts");
    const mlxUrl = pathToFileURL(join(process.cwd(), "src", "embeddings", "mlx.ts")).href;
    await writeFile(
      script,
      [
        `import { MlxEmbedder } from ${JSON.stringify(mlxUrl)};`,
        `const e = new MlxEmbedder({ pythonPath: ${JSON.stringify(fakeWorker)}, scriptPath: ${JSON.stringify(fakeWorker)} });`,
        'console.log(JSON.stringify(await e.embedTexts(["x"])));',
      ].join("\n"),
    );
    // Before the fix the child hung on the worker's pipes until killed by this timeout.
    const { stdout } = await execFileAsync(process.execPath, ["--import", "tsx", script], { timeout: 15000, cwd: process.cwd() });
    expect(stdout.trim()).toBe("[[0.5]]");
  }, 30000);

  it("queries carry the BGE instruction prefix; passages stay bare", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acg-mlx-prefix-"));
    const fakeWorker = join(dir, "python");
    // Encodes into the vector whether the text arrived prefixed.
    await writeFile(
      fakeWorker,
      [
        "#!/usr/bin/env node",
        'process.stderr.write("MLX worker ready\\n");',
        'const PREFIX = "Represent this sentence for searching relevant passages: ";',
        'require("readline").createInterface({ input: process.stdin }).on("line", (l) => {',
        "  const { id, texts } = JSON.parse(l);",
        '  process.stdout.write(JSON.stringify({ id, embeddings: texts.map((t) => [t.startsWith(PREFIX) ? 1 : 0]) }) + "\\n");',
        "});",
      ].join("\n"),
      { mode: 0o755 },
    );
    const embedder = new MlxEmbedder({ pythonPath: fakeWorker, scriptPath: fakeWorker });
    expect(await embedder.embedQuery("why did we replace Monaco")).toEqual([1]);
    expect(await embedder.embedTexts(["a stored passage"])).toEqual([[0]]);
    embedder.close();
  }, 30000);

  it("a wedged worker times out instead of hanging the caller", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acg-mlx-wedged-"));
    const python = join(dir, "python");
    await writeFile(python, "#!/bin/sh\necho 'MLX worker ready' >&2\nexec sleep 30\n", { mode: 0o755 });
    const embedder = new MlxEmbedder({ pythonPath: python, scriptPath: python, requestTimeoutMs: 300 });
    await expect(embedder.embedTexts(["x"])).rejects.toThrow(/timed out/);
  });
});

describe("vector store maintenance", () => {
  it("upsert tolerates a repeated id in one batch (Claude reuses uuids)", async () => {
    const dir = join(await mkdtemp(join(tmpdir(), "acg-vec-dup-")), "v");
    const vectors = await VectorStore.open(dir);
    const row = (id: string, v: number) => ({ id, vector: [v, v, v], harness: "claude-code", sessionId: "s", projectId: "p", timestampMs: 0 });
    await vectors.upsert([row("dup", 0.1), row("other", 0.2), row("dup", 0.3)]);
    expect(await vectors.count()).toBe(2);
    await vectors.upsert([row("dup", 0.4), row("dup", 0.5)]); // now matching an existing row
    expect(await vectors.count()).toBe(2);
    expect((await vectors.existing(["dup", "other"], 3)).size).toBe(2);
  });


  it("optimize() indexes ids and keeps lookups exact", async () => {
    const dir = join(await mkdtemp(join(tmpdir(), "acg-vec-opt-")), "v");
    const vectors = await VectorStore.open(dir);
    await vectors.upsert(
      ["a", "b", "c"].map((id) => ({ id, vector: [0.1, 0.2, 0.3], harness: "codex", sessionId: "s", projectId: "p", timestampMs: 0 })),
    );
    await vectors.optimize();
    const table = await (await lancedb.connect(dir)).openTable("turns_3");
    expect((await table.listIndices()).some((i) => i.columns.includes("id"))).toBe(true);
    expect([...(await vectors.existing(["a", "c", "zzz"], 3))].sort()).toEqual(["a", "c"]);
  });

  it("collapses a turn's windows into one hit, scored by its best window", async () => {
    const dir = join(await mkdtemp(join(tmpdir(), "acg-vec-collapse-")), "v");
    const vectors = await VectorStore.open(dir);
    const turn = "claude-code:s1:u-1";
    const row = (id: string, vector: number[]) => ({ id, vector, harness: "claude-code", sessionId: "s1", projectId: "p", timestampMs: 0 });
    await vectors.upsert([
      row(embedChunkId(turn, 0), [1, 0, 0]), // the head, unrelated to the query
      row(embedChunkId(turn, 1), [0, 1, 0]), // the tail, which answers it
      row("claude-code:s1:u-2", [0, 0, 1]),
    ]);
    const hits = await vectors.nearest([0, 1, 0], 10);
    const mine = hits.filter((h) => h.turnId === turn);
    expect(mine).toHaveLength(1); // one hit per turn, not per window
    expect(mine[0].similarity).toBeCloseTo(1, 5); // the best window, not the head and not a mean
    expect(hits.map((h) => h.turnId)).toContain("claude-code:s1:u-2"); // other turns survive
  });
});

describe("embedding windows", () => {
  it("leaves a turn that already fits as a single window", () => {
    expect(chunkForEmbedding("a short verdict")).toEqual(["a short verdict"]);
    expect(chunkForEmbedding("   ")).toEqual([]);
  });

  it("splits a long turn into windows that each fit the model's context", () => {
    const text = Array.from({ length: 300 }, (_, i) => `line ${i} about collaboration architecture`).join("\n");
    const chunks = chunkForEmbedding(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(EMBED_CHUNK_CHARS);
  });

  it("keeps the tail the 512-token window used to discard", () => {
    const filler = "the quarterly budget review is scheduled for friday. ".repeat(120);
    const text = `${filler}\n\nFINAL VERDICT: adopt CodeMirror over Monaco.`;
    expect(text.length).toBeGreaterThan(EMBED_CHUNK_CHARS * 2);
    const chunks = chunkForEmbedding(text);
    expect(chunks.some((c) => c.includes("FINAL VERDICT: adopt CodeMirror over Monaco."))).toBe(true);
  });

  it("loses no sentence at a window boundary (overlap covers the cut)", () => {
    const sentences = Array.from({ length: 200 }, (_, i) => `sentence ${i} carrying distinct content.`);
    const chunks = chunkForEmbedding(sentences.join(" "));
    for (const s of sentences) expect(chunks.some((c) => c.includes(s))).toBe(true);
  });

  it("window 0 keeps the bare turn id, so rows written before chunking stay valid", () => {
    const tid = "claude-code:sess-1:u-1";
    expect(embedChunkId(tid, 0)).toBe(tid);
    expect(embedChunkId(tid, 3)).toBe(`${tid}#3`);
    expect(chunkTurnId(embedChunkId(tid, 3))).toBe(tid);
    expect(chunkTurnId(tid)).toBe(tid);
    expect(chunkTurnId("zep:od#d:t1")).toBe("zep:od#d:t1"); // a `#` that isn't ours
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

  it("embeds a long turn in windows, adding only the ones a pre-chunking corpus lacks", async () => {
    const root = await mkdtemp(join(tmpdir(), "acg-vec-windows-"));
    const claudeDir = join(root, "claude");
    const sid = "cdcdcdcd-1111-2222-3333-444444444444";
    await mkdir(join(claudeDir, "p"), { recursive: true });
    const long = `${"the collaboration workbench stays private. ".repeat(150)}\n\nFINAL: adopt CodeMirror.`;
    await writeFile(
      join(claudeDir, "p", `${sid}.jsonl`),
      JSON.stringify({ type: "assistant", uuid: "a1", timestamp: "2026-09-10T10:00:00Z", sessionId: sid, cwd: "/repo/p", message: { role: "assistant", content: [{ type: "text", text: long }] } }),
    );
    const adapter = new ClaudeAdapter(claudeDir);
    const [session] = await adapter.listSessions();
    const [turn] = await adapter.listTurns(sid);
    const windows = chunkForEmbedding(turn.content).length;
    expect(windows).toBeGreaterThan(1);

    const vectors = await VectorStore.open(join(root, "vectors"));
    // A corpus embedded before chunking existed: the whole turn under its bare id.
    await vectors.upsert([{ id: turn.id, vector: new Array(MLX_DIM).fill(0.01), harness: turn.harness, sessionId: sid, projectId: "p", timestampMs: 0 }]);

    const res = await embedSessionTurns(adapter, session, vectors, 64, "mlx");
    expect(res.embedded).toBe(1); // counted in turns, though several windows were written
    expect(await vectors.count()).toBe(windows); // window 0 reused, the tail backfilled

    const again = await embedSessionTurns(adapter, session, vectors, 64, "mlx");
    expect(again.embedded).toBe(0); // and it stays resumable
    expect(await vectors.count()).toBe(windows);
  }, 60000);
});
