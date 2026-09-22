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
import { LruCache } from "../core/lru.js";
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
import {
  VOYAGE_CONTEXT,
  voyageContextAvailable,
  embedDocumentGroups,
  embedQueryText as embedContextQuery,
} from "./voyage-context.js";

import type { EngineName as EmbeddingEngine } from "../components.js";
export type { EngineName as EmbeddingEngine } from "../components.js";

export interface EmbeddingProvider {
  readonly engine: EmbeddingEngine;
  /** Vector width. Storage is keyed by engine; this is for validation and reporting. */
  readonly dim: number;
  /** True when this engine can actually serve a request right now. */
  isAvailable(): Promise<boolean>;
  /**
   * Embed texts. `groups[i]` optionally names the document texts[i] belongs
   * to; engines with document-level context (voyage-context) encode each
   * group jointly, others embed independently and ignore it. Returned rows
   * always align 1:1 with inputs.
   */
  embedTexts(texts: string[], groups?: string[]): Promise<number[][]>;
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
    // Groups are a voyage-context concept; flat engines ignore them.
    embedTexts: (texts) => ollamaEmbedTexts(texts),
    embedQuery: ollamaEmbedQuery,
  },
  voyage: voyageProvider("voyage", VOYAGE_GENERAL),
  "voyage-code": voyageProvider("voyage-code", VOYAGE_CODE),
  "voyage-context": {
    engine: "voyage-context",
    get dim() {
      return VOYAGE_CONTEXT.dim;
    },
    isAvailable: async () => voyageContextAvailable(),
    embedTexts: async (texts, groups) => {
      // Group texts back into per-document chunk lists (order-preserving);
      // ungrouped callers get one chunk per document (valid, not contextual).
      const order: string[] = [];
      const seen = new Map<string, number>();
      const lists: string[][] = [];
      texts.forEach((t, i) => {
        const g = groups?.[i] ?? `__solo_${i}`;
        let gi = seen.get(g);
        if (gi === undefined) {
          gi = lists.length;
          seen.set(g, gi);
          lists.push([]);
          order.push(g);
        }
        lists[gi].push(t);
      });
      const vecs = await embedDocumentGroups(VOYAGE_CONTEXT, lists);
      const out: number[][] = new Array(texts.length);
      const taken = new Map<string, number>();
      texts.forEach((_, i) => {
        const g = groups?.[i] ?? `__solo_${i}`;
        const gi = seen.get(g)!;
        out[i] = vecs[gi][taken.get(g) ?? 0];
        taken.set(g, (taken.get(g) ?? 0) + 1);
      });
      return out;
    },
    embedQuery: (query) => embedContextQuery(VOYAGE_CONTEXT, query),
  },
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
  get "voyage-context"() {
    return PROVIDERS["voyage-context"].dim;
  },
} as Record<EmbeddingEngine, number>;

import { ENGINE_ORDER } from "../components.js";
const DEFAULT_ORDER: readonly EmbeddingEngine[] = ENGINE_ORDER;

function preferredOrder(): readonly EmbeddingEngine[] {
  const pinned = process.env.GATEWAY_EMBED_ENGINE as EmbeddingEngine | undefined;
  // A pinned engine is a hard selection, not a hint: falling back past it would
  // scatter one corpus across two tables, which is what pinning exists to stop.
  if (pinned && PROVIDERS[pinned]) return [pinned];
  return DEFAULT_ORDER;
}

/**
 * Degradation meter: incremented every time a query embedding fails and the
 * caller falls back to lexical-only. Sweep rows with fallbacks > 0 are
 * flagged non-comparable — a silent catch turned a vector outage into a
 * plausible-looking lexical number at least once.
 */
export const embedMeter = {
  fallbacks: 0,
  reset() {
    this.fallbacks = 0;
  },
  snapshot() {
    return { fallbacks: this.fallbacks };
  },
};

/** The engine that will serve requests, or "none" when nothing is reachable. */
export async function resolveEngine(): Promise<EmbeddingEngine | "none"> {
  for (const engine of preferredOrder()) {
    if (await PROVIDERS[engine].isAvailable().catch(() => false)) return engine;
  }
  return "none";
}

/** Embed with one specific engine — no fallback, so a backfill never mixes tables. */
export async function embedTextsWith(
  engine: EmbeddingEngine,
  texts: string[],
  groups?: string[],
): Promise<number[][]> {
  return getProvider(engine).embedTexts(texts, groups);
}

/**
 * Query-embedding cache.
 *
 * A query embedding is a pure function of (engine, text), so this is safe to
 * cache for the process lifetime — nothing about the corpus can change it.
 * Worth doing because it is the single largest fixed cost on the search path:
 * ~290ms of the ~780ms p50 is this one network round trip to Voyage, paid
 * before any candidate is scored.
 *
 * Keyed by engine as well as text: the same string embedded by two engines
 * lands in two different vector spaces, and serving one for the other would
 * silently return garbage neighbours rather than fail.
 *
 * Bounded by vector count and by total floats, so a long-running server cannot
 * grow this without limit. 512 entries of 1024 dims is ~4MB at 8 bytes each.
 */
const QUERY_VECTOR_CACHE = new LruCache<string, number[]>(512, 512 * 1024, (v) => v.length);

/** Exposed for tests and for operators who need a clean measurement. */
export function clearQueryVectorCache(): void {
  QUERY_VECTOR_CACHE.clear();
}

export async function embedQueryWith(engine: EmbeddingEngine, query: string): Promise<number[]> {
  const key = `${engine}\u0000${query}`;
  const hit = QUERY_VECTOR_CACHE.get(key);
  if (hit) return hit;
  const vector = await getProvider(engine).embedQuery(query);
  QUERY_VECTOR_CACHE.set(key, vector);
  return vector;
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
