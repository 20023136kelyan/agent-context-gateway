/**
 * Ollama embedding client (Phase 2 semantic slice).
 * Model: qwen3-embedding:0.6b (1024-dim, local, Apple Silicon GPU).
 * Chosen over NLEmbedding (spike 2026-09-15: wrong similarity ordering)
 * and nomic-embed-text (registry blob unreachable from here, EOF).
 *
 * Embeddings are DERIVED + disposable like the lexical index: delete the
 * vector store and re-backfill from native histories.
 */
export const EMBED_MODEL = "qwen3-embedding:0.6b";
export const EMBED_DIM = 1024;
/** Truncate turn text for embedding: head keeps the topic, tail is noise. */
export const EMBED_MAX_CHARS = 2000;

const base = () => process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434";

export async function ollamaAvailable(timeoutMs = 2000): Promise<boolean> {
  try {
    const res = await fetch(`${base()}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function embedTexts(texts: string[], model = EMBED_MODEL): Promise<number[][]> {
  if (texts.length === 0) return [];
  const res = await fetch(`${base()}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      input: texts.map((t) => t.slice(0, EMBED_MAX_CHARS)),
      keep_alive: "60m",
    }),
  });
  if (!res.ok) throw new Error(`ollama embed failed: ${res.status} ${await res.text().catch(() => "")}`);
  const body = (await res.json()) as { embeddings?: number[][] };
  if (!Array.isArray(body.embeddings) || body.embeddings.length !== texts.length) {
    throw new Error("ollama embed: bad response shape");
  }
  return body.embeddings;
}

export async function embedQuery(query: string): Promise<number[]> {
  return (await embedTexts([query]))[0];
}
