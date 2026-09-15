/**
 * Unified Embeddings Provider.
 * Prefers native Apple Silicon MLX (BGE-small on Metal GPU, ~150-160 emb/s, in-process).
 * Gracefully falls back to Ollama if MLX venv is not configured.
 */
import { getSharedMlxEmbedder, MlxEmbedder, MLX_DIM } from "./mlx.js";
export { getSharedMlxEmbedder, MlxEmbedder };
import {
  embedTexts as ollamaEmbedTexts,
  embedQuery as ollamaEmbedQuery,
  ollamaAvailable,
  EMBED_DIM as OLLAMA_DIM,
} from "./ollama.js";

export type EmbeddingEngine = "mlx" | "ollama";

/** Each engine writes its own dimension's vector table. */
export const ENGINE_DIM: Record<EmbeddingEngine, number> = { mlx: MLX_DIM, ollama: OLLAMA_DIM };

/** Embed with one specific engine — no fallback, so a backfill never mixes tables. */
export async function embedTextsWith(engine: EmbeddingEngine, texts: string[]): Promise<number[][]> {
  return engine === "mlx" ? getSharedMlxEmbedder().embedTexts(texts) : ollamaEmbedTexts(texts);
}

export async function isMlxAvailable(): Promise<boolean> {
  const mlx = getSharedMlxEmbedder();
  return mlx.isAvailable();
}

export async function embedTexts(texts: string[]): Promise<number[][]> {
  const mlx = getSharedMlxEmbedder();
  if (await mlx.isAvailable()) {
    try {
      return await mlx.embedTexts(texts);
    } catch {
      // fallback to Ollama
    }
  }
  return ollamaEmbedTexts(texts);
}

export async function embedQuery(query: string): Promise<number[]> {
  const mlx = getSharedMlxEmbedder();
  if (await mlx.isAvailable()) {
    try {
      return await mlx.embedQuery(query);
    } catch {
      // fallback to Ollama
    }
  }
  return ollamaEmbedQuery(query);
}

export async function embeddingsAvailable(): Promise<{
  available: boolean;
  engine: "mlx" | "ollama" | "none";
}> {
  if (await isMlxAvailable()) {
    return { available: true, engine: "mlx" };
  }
  if (await ollamaAvailable()) {
    return { available: true, engine: "ollama" };
  }
  return { available: false, engine: "none" };
}
