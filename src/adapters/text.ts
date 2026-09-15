/** Shared text helpers for adapters (MVP). */
const MAX_CONTENT = 8000;

/** Bounds for each adapter's parsed-turn cache (long-running serve): ~100MB of UTF-16 content. */
export const TURN_CACHE_SESSIONS = 128;
export const TURN_CACHE_CHARS = 50_000_000;

export function turnChars(turns: { content: string }[]): number {
  return turns.reduce((n, t) => n + t.content.length, 0);
}

export function truncate(s: string, max = MAX_CONTENT): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "…[truncated]";
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
