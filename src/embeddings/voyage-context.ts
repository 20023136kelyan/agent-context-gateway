/**
 * Voyage contextualized embedding provider (remote).
 *
 * voyage-context-4 encodes each chunk WITH its document context in one
 * forward pass (cf. Anthropic contextual retrieval without the LLM
 * augmentation step). The provider therefore takes grouped inputs: texts
 * sharing a group id are sent as one document's chunks and come back with
 * per-chunk vectors that see the whole group. Unshifted callers (no groups)
 * get one chunk per document — valid, but none of the contextual benefit.
 *
 * Opt-in ONLY via GATEWAY_EMBED_ENGINE=voyage-context pin (never in the
 * default order): different endpoint, different table, $0.12/M pricing, and
 * a backfill against the wrong engine silently writes incomparable vectors
 * into a valid-looking table (same dim as voyage-4).
 */
import type { VoyageConfig } from "./voyage.js";
import { voyageMeter } from "./voyage.js";

const ENDPOINT = process.env.VOYAGE_ENDPOINT ?? "https://api.voyageai.com/v1/embeddings";
const CONTEXT_ENDPOINT = ENDPOINT.replace(/\/embeddings\/?$/, "") + "/contextualizedembeddings";
const TIMEOUT_MS = Number(process.env.VOYAGE_TIMEOUT_MS ?? 60_000);

export const VOYAGE_CONTEXT: VoyageConfig = {
  model: process.env.VOYAGE_CONTEXT_MODEL ?? "voyage-context-4",
  dim: Number(process.env.VOYAGE_CONTEXT_DIM ?? 1024),
};

export function voyageContextAvailable(): boolean {
  return Boolean(process.env.VOYAGE_API_KEY);
}

type WireEmbedding = { object?: string; embedding?: number[] };

function extractVector(node: unknown, dim: number, model: string): number[] {
  const emb = (node as WireEmbedding)?.embedding;
  if (!Array.isArray(emb) || emb.length !== dim) {
    throw new Error(`voyage-dim-mismatch: ${model} returned ${Array.isArray(emb) ? emb.length : "non-array"}, configured ${dim}`);
  }
  return emb;
}

/** Documents: groups of chunk-lists; returns per-group per-chunk vectors. */
export async function embedDocumentGroups(cfg: VoyageConfig, groups: string[][]): Promise<number[][][]> {
  const key = process.env.VOYAGE_API_KEY;
  if (!key) throw new Error("voyage-no-api-key");
  if (groups.length === 0) return [];
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(CONTEXT_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: cfg.model, inputs: groups, input_type: "document" }),
      signal: ac.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`voyage-http-${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
  }
  const body = (await res.json()) as { data?: { object?: string; data?: unknown[] }[]; usage?: { total_tokens?: number } };
  voyageMeter.requests += 1;
  voyageMeter.tokens += body.usage?.total_tokens ?? 0;
  const lists = body.data ?? [];
  if (lists.length !== groups.length) {
    throw new Error(`voyage-bad-response: expected ${groups.length} documents, got ${lists.length}`);
  }
  return lists.map((doc, gi) => {
    const chunks = Array.isArray(doc?.data) ? doc.data : [];
    if (chunks.length !== groups[gi].length) {
      throw new Error(`voyage-bad-response: doc ${gi} has ${chunks.length} vectors for ${groups[gi].length} chunks`);
    }
    return chunks.map((c) => extractVector(c, cfg.dim, cfg.model));
  });
}

/** Queries embed flat (context-agnostic per Voyage docs). */
export async function embedQueryText(cfg: VoyageConfig, query: string): Promise<number[]> {
  const key = process.env.VOYAGE_API_KEY;
  if (!key) throw new Error("voyage-no-api-key");
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(CONTEXT_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: cfg.model, inputs: [query], input_type: "query" }),
      signal: ac.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`voyage-http-${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
  }
  const body = (await res.json()) as { data?: unknown[]; usage?: { total_tokens?: number } };
  voyageMeter.requests += 1;
  voyageMeter.tokens += body.usage?.total_tokens ?? 0;
  const first = body.data?.[0] as unknown;
  // Flat query input still comes back nested ({list:[{embedding}]}), like a
  // one-chunk document. Unwrap one level, then accept a bare embedding.
  const inner = (first as { data?: unknown[] })?.data?.[0] ?? first;
  const node = Array.isArray(inner) ? inner[0] : inner;
  return extractVector(node, cfg.dim, cfg.model);
}
