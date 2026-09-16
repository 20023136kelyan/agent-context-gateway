/** Shared text helpers for adapters (MVP). */
const MAX_CONTENT = 8000;

/**
 * Bounds for each adapter's parsed-turn cache (long-running serve). Sized to
 * hold the whole working set: a measured corpus was 106M chars with a single
 * 51M-char session, and a budget below the working set thrashes into
 * re-parsing multi-MB files on every search. The bound caps future growth.
 */
export const TURN_CACHE_SESSIONS = 256;
export const TURN_CACHE_CHARS = 200_000_000;

export function turnChars(turns: { content: string }[]): number {
  return turns.reduce((n, t) => n + t.content.length, 0);
}

export function truncate(s: string, max = MAX_CONTENT): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "…[truncated]";
}

/**
 * ~500 tokens at the ~3.2 chars/token that code-heavy turns tokenize to,
 * leaving room under BGE-small's 512-token window. Prose runs nearer 3.9
 * chars/token, so prose chunks land further inside the window, never outside.
 */
export const EMBED_CHUNK_CHARS = 1600;
/** A sentence cut by a window boundary is still whole in the neighbouring one. */
export const EMBED_CHUNK_OVERLAP = 200;
/**
 * Guard, not a policy: `truncate` already bounds a turn at MAX_CONTENT, which
 * yields at most 9 windows even at the shortest stride. A caller passing
 * unbounded text gets cut off rather than embedding a novel.
 */
export const EMBED_MAX_CHUNKS = 12;

/**
 * Pull the cut back to a natural boundary, but never shrink a window by more
 * than a quarter — an unbounded search would let one unlucky window collapse
 * the stride and emit a chunk per sentence.
 */
function breakBefore(s: string, start: number, end: number): number {
  const floor = start + Math.floor((end - start) * 0.75);
  for (const sep of ["\n\n", "\n", ". ", " "]) {
    const i = s.lastIndexOf(sep, end);
    if (i >= floor) return i + sep.length;
  }
  return end;
}

/**
 * Split a turn into windows the embedder can actually read.
 *
 * BGE-small reads at most 512 tokens and silently drops the rest: appending
 * 400 tokens to an 842-token document returns a bit-identical vector
 * (cos = 1.00000, against 0.874 for a short control). Since turns are kept to
 * 8000 chars and were embedded whole, ~32% of every indexed character was
 * invisible to the model — concentrated in the long turns that hold plans and
 * verdicts — while BM25 read all of it. Embedding each window instead is what
 * makes a stored vector describe the text it is filed under.
 */
export function chunkForEmbedding(
  text: string,
  max = EMBED_CHUNK_CHARS,
  overlap = EMBED_CHUNK_OVERLAP,
): string[] {
  const s = text.trim();
  if (!s) return [];
  if (s.length <= max) return [s];
  const out: string[] = [];
  let start = 0;
  while (start < s.length && out.length < EMBED_MAX_CHUNKS) {
    let end = Math.min(start + max, s.length);
    if (end < s.length) end = breakBefore(s, start, end);
    const piece = s.slice(start, end).trim();
    if (piece) out.push(piece);
    if (end >= s.length) break;
    // Step from the cut, never from a fixed stride: a boundary that pulled the
    // window back would otherwise skip the text between `end` and the stride.
    start = Math.max(start + 1, end - overlap);
  }
  return out;
}

// The trailing lookahead stops ".json" matching as ".js" (and ".tsx" as ".ts").
const FILE_RE = /(?:PR\s+#\d+|src\/[A-Za-z0-9_./-]+\.[A-Za-z0-9]+|[A-Za-z0-9_./-]+\.(?:tsx|ts|jsx|json|js|py|rs|go|md))(?![A-Za-z0-9])/g;

export function extractFileRefs(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(FILE_RE)) out.add(m[0]);
  return [...out].slice(0, 20);
}

// Hyphen neighbours are excluded so UUID segments ("3f2a9b1c-…") don't count.
const SHA_RE = /(?<![0-9A-Za-z_-])[0-9a-f]{7,40}(?![0-9A-Za-z_-])/g;
const PR_URL_RE = /https?:\/\/[^\s)]+\/pull\/\d+[^\s)]*/g;

/** Commit SHAs mentioned in text (7-40 hex; hints, not verified against git). */
export function extractCommitShas(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(SHA_RE)) {
    const sha = m[0];
    // Pure numbers and hex-only words ("defaced") are not shas.
    if (!/\d/.test(sha) || !/[a-f]/.test(sha)) continue;
    out.add(sha);
  }
  return [...out].slice(0, 20);
}

/** PR URLs (github and friends) mentioned in text. */
export function extractPrUrls(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(PR_URL_RE)) out.add(m[0].replace(/[.,;]+$/, ""));
  return [...out].slice(0, 10);
}

/** All packaging artifacts for a text: files + commits + PR URLs. */
export function extractArtifacts(text: string): string[] {
  return [
    ...extractFileRefs(text),
    ...extractCommitShas(text).map((s) => `commit:${s}`),
    ...extractPrUrls(text),
  ].slice(0, 30);
}

/** Claude message.content can be string | array of blocks | null */
export function claudeContentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const b of content) {
      if (typeof b === "string") parts.push(b);
      else if (b && typeof b === "object") {
        const block = b as Record<string, unknown>;
        if (typeof block.text === "string") parts.push(block.text);
        else if (typeof block.input === "string") parts.push(block.input);
        // tool_result blocks: { content: string | [...] }
        else if (typeof block.content === "string") parts.push(block.content);
        else if (Array.isArray(block.content)) parts.push(claudeContentToText(block.content));
      }
    }
    return parts.join("\n");
  }
  return "";
}

/**
 * True when a Claude `user` line carries only tool_result blocks. Such a line
 * is tool output (a file read, a command's stdout) wearing the user role, not
 * something a person said. Consumers that reason about what was *stated* —
 * decision extraction — must not read it as an utterance.
 */
export function isToolResultContent(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  let sawToolResult = false;
  for (const b of content) {
    if (typeof b === "string") {
      if (b.trim()) return false; // real prose alongside the results
      continue;
    }
    if (!b || typeof b !== "object") continue;
    const block = b as Record<string, unknown>;
    if (block.type === "tool_result") {
      sawToolResult = true;
      continue;
    }
    if (typeof block.text === "string" && block.text.trim()) return false;
  }
  return sawToolResult;
}

export function claudeToolNames(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const names: string[] = [];
  for (const b of content) {
    if (b && typeof b === "object" && (b as Record<string, unknown>).type === "tool_use") {
      const name = (b as Record<string, unknown>).name;
      if (typeof name === "string") names.push(name);
    }
  }
  return names;
}

/** Codex content: array of {type: input_text|output_text|text, text} */
export function codexContentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const b of content) {
      if (b && typeof b === "object") {
        const block = b as Record<string, unknown>;
        if (typeof block.text === "string") parts.push(block.text);
      } else if (typeof b === "string") parts.push(b);
    }
    return parts.join("\n");
  }
  return "";
}
