/**
 * Unified Embeddings Provider.
 *
 * Engines are registered, not hard-coded, so adding a vendor never touches the
 * retrieval path. Each engine owns its own vector table (see VectorStore):
 * identity is the ENGINE, not the dimension. Two engines can emit the same
 * width — Ollama's Qwen and a 1024-dim Voyage model do — and keying storage by
 * width alone would silently blend two incompatible embedding spaces.
 *
 * Selection order (first available wins), overridable with GATEWAY_EMBED_ENGINE:
 *   voyage → mlx → ollama
 * Voyage leads only when VOYAGE_API_KEY is set; setting that key is the opt-in
 * that sends history off-machine (spec §73 Principle 5 is local-first).
 * MLX needs Apple Silicon, so on Intel the order collapses to voyage → ollama.
 */
import { getSharedMlxEmbedder, MlxEmbedder, MLX_DIM } from "./mlx.js";
export { getSharedMlxEmbedder, MlxEmbedder };
import {
  embedTexts as ollamaEmbedTexts,
  embedQuery as ollamaEmbedQuery,
  ollamaAvailable,
  EMBED_DIM as OLLAMA_DIM,
} from "./ollama.js";
import {
  VOYAGE_GENERAL,
  VOYAGE_CODE,
  voyageAvailable,
  embedDocuments,
  embedQueryText,
  type VoyageConfig,
} from "./voyage.js";

export type EmbeddingEngine = "mlx" | "ollama" | "voyage" | "voyage-code";

export interface EmbeddingProvider {
  readonly engine: EmbeddingEngine;
  /** Vector width. Storage is keyed by engine; this is for validation and reporting. */
  readonly dim: number;
  /** True when this engine can actually serve a request right now. */
  isAvailable(): Promise<boolean>;
  embedTexts(texts: string[]): Promise<number[][]>;
  embedQuery(query: string): Promise<number[]>;
}

const voyageProvider = (engine: EmbeddingEngine, cfg: VoyageConfig): EmbeddingProvider => ({
  engine,
  get dim() {
    return cfg.dim;
  },
  isAvailable: async () => voyageAvailable(),
  embedTexts: (texts) => embedDocuments(cfg, texts),
  embedQuery: (query) => embedQueryText(cfg, query),
});

const PROVIDERS: Record<EmbeddingEngine, EmbeddingProvider> = {
  mlx: {
    engine: "mlx",
    dim: MLX_DIM,
    isAvailable: () => getSharedMlxEmbedder().isAvailable(),
    embedTexts: (texts) => getSharedMlxEmbedder().embedTexts(texts),
    embedQuery: (query) => getSharedMlxEmbedder().embedQuery(query),
  },
  ollama: {
    engine: "ollama",
    dim: OLLAMA_DIM,
    isAvailable: () => ollamaAvailable(),
    embedTexts: ollamaEmbedTexts,
    embedQuery: ollamaEmbedQuery,
  },
  voyage: voyageProvider("voyage", VOYAGE_GENERAL),
  "voyage-code": voyageProvider("voyage-code", VOYAGE_CODE),
};

export const ENGINES = Object.keys(PROVIDERS) as EmbeddingEngine[];

export function getProvider(engine: EmbeddingEngine): EmbeddingProvider {
  const p = PROVIDERS[engine];
  if (!p) throw new Error(`unknown-embedding-engine: ${engine}`);
  return p;
}

/** Each engine's vector width. Kept for reporting; storage keys on engine. */
export const ENGINE_DIM: Record<EmbeddingEngine, number> = {
  get mlx() {
    return PROVIDERS.mlx.dim;
  },
  get ollama() {
    return PROVIDERS.ollama.dim;
  },
  get voyage() {
    return PROVIDERS.voyage.dim;
  },
  get "voyage-code"() {
    return PROVIDERS["voyage-code"].dim;
  },
} as Record<EmbeddingEngine, number>;

const DEFAULT_ORDER: EmbeddingEngine[] = ["voyage", "mlx", "ollama"];

function preferredOrder(): EmbeddingEngine[] {
  const pinned = process.env.GATEWAY_EMBED_ENGINE as EmbeddingEngine | undefined;
  // A pinned engine is a hard selection, not a hint: falling back past it would
  // scatter one corpus across two tables, which is what pinning exists to stop.
  if (pinned && PROVIDERS[pinned]) return [pinned];
  return DEFAULT_ORDER;
}

/** The engine that will serve requests, or "none" when nothing is reachable. */
export async function resolveEngine(): Promise<EmbeddingEngine | "none"> {
  for (const engine of preferredOrder()) {
    if (await PROVIDERS[engine].isAvailable().catch(() => false)) return engine;
  }
  return "none";
}

/** Embed with one specific engine — no fallback, so a backfill never mixes tables. */
export async function embedTextsWith(engine: EmbeddingEngine, texts: string[]): Promise<number[][]> {
  return getProvider(engine).embedTexts(texts);
}

export async function embedQueryWith(engine: EmbeddingEngine, query: string): Promise<number[]> {
  return getProvider(engine).embedQuery(query);
}

export async function isMlxAvailable(): Promise<boolean> {
  return PROVIDERS.mlx.isAvailable();
}

/**
 * Embed a query AND report which engine did it. Search needs both: a query
 * vector is only comparable against the table written by the same engine.
 */
export async function embedQueryResolved(query: string): Promise<{ engine: EmbeddingEngine; vector: number[] } | null> {
  const engine = await resolveEngine();
  if (engine === "none") return null;
  return { engine, vector: await embedQueryWith(engine, query) };
}

export async function embedTexts(texts: string[]): Promise<number[][]> {
  const engine = await resolveEngine();
  if (engine === "none") throw new Error("embeddings-unavailable");
  return embedTextsWith(engine, texts);
}

export async function embedQuery(query: string): Promise<number[]> {
  const engine = await resolveEngine();
  if (engine === "none") throw new Error("embeddings-unavailable");
  return embedQueryWith(engine, query);
}

export async function embeddingsAvailable(): Promise<{
  available: boolean;
  engine: EmbeddingEngine | "none";
}> {
  const engine = await resolveEngine();
  return { available: engine !== "none", engine };
}
