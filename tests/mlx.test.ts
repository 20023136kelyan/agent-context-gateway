/**
 * Unit & integration tests for Native Apple Silicon MLX Embedding Sidecar (Phase D).
 */
import { describe, it, expect } from "vitest";
import { getSharedMlxEmbedder, MLX_DIM } from "../src/embeddings/mlx.js";
import { embeddingsAvailable, embedTexts, embedQuery } from "../src/embeddings/provider.js";

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
