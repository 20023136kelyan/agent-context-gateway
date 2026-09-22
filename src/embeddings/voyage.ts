/**
 * Voyage AI embedding provider (remote).
 *
 * This sends turn text to a third party, and since the local engines (MLX,
 * Ollama) were deleted every engine does. That is a
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
import { scrubText } from "../security/scrub.js";

const ENDPOINT = process.env.VOYAGE_ENDPOINT ?? "https://api.voyageai.com/v1/embeddings";
const TIMEOUT_MS = Number(process.env.VOYAGE_TIMEOUT_MS ?? 30_000);

/**
 * Transient failures retry with exponential backoff: a timeout, a network
 * error, 429 or 5xx. Without this one slow response killed a 46k-chunk
 * backfill outright (2026-09-23). A 400 or a dimension mismatch will not change
 * on retry, so those still fail at once. Read per call so tests can shorten it.
 */
const maxAttempts = () => Math.max(1, Number(process.env.VOYAGE_MAX_ATTEMPTS ?? 4));
const backoffBaseMs = () => Math.max(0, Number(process.env.VOYAGE_BACKOFF_MS ?? 1000));

function retryable(status: number): boolean {
  return status === 429 || status >= 500;
}

/** Retry-After (seconds) when the server sends one, else jittered exponential. */
function backoffMs(attempt: number, retryAfter: string | null): number {
  const hinted = retryAfter ? Number(retryAfter) * 1000 : NaN;
  if (Number.isFinite(hinted) && hinted >= 0) return Math.min(hinted, 60_000);
  return backoffBaseMs() * 2 ** (attempt - 1) * (0.5 + Math.random());
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

/**
 * Process-wide usage meter (measure-first spend discipline). Voyage reports
 * `usage.total_tokens` per response; the sweep runner resets per cell. Calls
 * whose responses carry no usage block still count as requests.
 */
export const voyageMeter = {
  requests: 0,
  tokens: 0,
  reset() {
    this.requests = 0;
    this.tokens = 0;
  },
  snapshot() {
    return { requests: this.requests, tokens: this.tokens };
  },
};

/** Lone surrogates from binary tool output are not valid UTF-8: Voyage 400s
 *  the whole batch for one bad turn. Real histories always contain some. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

async function call(cfg: VoyageConfig, input: string[], inputType: "query" | "document"): Promise<number[][]> {
  const key = process.env.VOYAGE_API_KEY;
  if (!key) throw new Error("voyage-no-api-key");
  if (input.length === 0) return [];
  // Scrubbed here as the last line of defence; callers that chunk scrub first.
  input = input.map((t) => scrubText(t).replace(LONE_SURROGATE, "\uFFFD"));

  const payload = JSON.stringify({ model: cfg.model, input, input_type: inputType, output_dimension: cfg.dim });
  let res: Response;
  for (let attempt = 1; ; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    try {
      res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: payload,
        signal: ac.signal,
      });
    } catch (err) {
      // Timeout (AbortError) or a dropped connection: transient.
      if (attempt >= maxAttempts()) throw err;
      await sleep(backoffMs(attempt, null));
      continue;
    } finally {
      clearTimeout(timer);
    }
    if (res.ok || !retryable(res.status) || attempt >= maxAttempts()) break;
    await sleep(backoffMs(attempt, res.headers.get("retry-after")));
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`voyage-http-${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
  }

  const body = (await res.json()) as {
    data?: { embedding: number[]; index: number }[];
    usage?: { total_tokens?: number };
  };
  voyageMeter.requests += 1;
  voyageMeter.tokens += body.usage?.total_tokens ?? 0;
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
