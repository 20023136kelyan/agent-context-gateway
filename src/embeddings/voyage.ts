/**
 * Voyage AI embedding provider (remote).
 *
 * Unlike MLX and Ollama this sends turn text to a third party, which is a
 * deliberate departure from spec §73 Principle 5 (local-first) and §25
 * (security boundary). It is therefore never selected implicitly: a request
 * needs VOYAGE_API_KEY, and setting that key is the opt-in.
 *
 * Model and dimension are configuration, not constants. Voyage ships several
 * models and several of them emit the same width, so a wrong guess here would
 * write a foreign embedding space into a table that looks compatible. The
 * dimension is asserted against what the API actually returns and a mismatch
 * throws rather than corrupting the store.
 */
const ENDPOINT = process.env.VOYAGE_ENDPOINT ?? "https://api.voyageai.com/v1/embeddings";
const TIMEOUT_MS = Number(process.env.VOYAGE_TIMEOUT_MS ?? 30_000);

export interface VoyageConfig {
  model: string;
  dim: number;
}

/**
 * General-purpose retrieval model. Confirmed against the live API on
 * 2026-09-19: voyage-4 returns 1024 dims natively and honours output_dimension.
 */
export const VOYAGE_GENERAL: VoyageConfig = {
  model: process.env.VOYAGE_MODEL ?? "voyage-4",
  dim: Number(process.env.VOYAGE_DIM ?? 1024),
};

/** Code-specialised sibling. Note the name is voyage-code-4, not voyage-4-code. */
export const VOYAGE_CODE: VoyageConfig = {
  model: process.env.VOYAGE_CODE_MODEL ?? "voyage-code-4",
  dim: Number(process.env.VOYAGE_CODE_DIM ?? 1024),
};

export function voyageAvailable(): boolean {
  return Boolean(process.env.VOYAGE_API_KEY);
}

async function call(cfg: VoyageConfig, input: string[], inputType: "query" | "document"): Promise<number[][]> {
  const key = process.env.VOYAGE_API_KEY;
  if (!key) throw new Error("voyage-no-api-key");
  if (input.length === 0) return [];

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: cfg.model, input, input_type: inputType, output_dimension: cfg.dim }),
      signal: ac.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`voyage-http-${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
  }

  const body = (await res.json()) as { data?: { embedding: number[]; index: number }[] };
  const data = body.data;
  if (!Array.isArray(data) || data.length !== input.length) {
    throw new Error(`voyage-bad-response: expected ${input.length} embeddings, got ${data?.length ?? 0}`);
  }
  // Order is documented but not guaranteed across retries; sort by index.
  const ordered = [...data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
  for (const v of ordered) {
    if (v.length !== cfg.dim) {
      // Louder than a silent write: a foreign width in a shared table is the
      // exact corruption this provider exists to avoid.
      throw new Error(`voyage-dim-mismatch: ${cfg.model} returned ${v.length}, configured ${cfg.dim}`);
    }
  }
  return ordered;
}

/** Documents and queries use different input types; Voyage ranks better when told which. */
export const embedDocuments = (cfg: VoyageConfig, texts: string[]) => call(cfg, texts, "document");
export const embedQueryText = async (cfg: VoyageConfig, query: string) => (await call(cfg, [query], "query"))[0];
