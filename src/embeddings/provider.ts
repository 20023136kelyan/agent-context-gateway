/**
 * Unified Embeddings Provider.
 * Prefers native Apple Silicon MLX (BGE-small on Metal GPU, ~150-160 emb/s, in-process).
 * Gracefully falls back to Ollama if MLX venv is not configured.
 */
import { getSharedMlxEmbedder, MlxEmbedder } from "./mlx.js";
export { getSharedMlxEmbedder, MlxEmbedder };
import {
  embedTexts as ollamaEmbedTexts,
  embedQuery as ollamaEmbedQuery,
  ollamaAvailable,
} from "./ollama.js";

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
