/**
 * Query normalization for M3 lexical search.
 * No LLM rewrite in MVP — deterministic string ops only.
 *
 * Produces:
 * - indexQuery: space-joined terms safe for Tantivy QueryParser / SQLite FTS5
 * - entities: PR numbers + file refs for ranking boosts
 * - after/before: temporal post-filters
 */
import { extractFileRefs } from "../adapters/text.js";

export interface NormalizedQuery {
  original: string;
  indexQuery: string;
  prNumbers: string[];
  fileRefs: string[];
  after?: string;
  before?: string;
}

export const STOP = new Set([
  "what", "did", "does", "do", "the", "a", "an", "about", "is", "was", "were",
  "how", "why", "we", "you", "they", "them", "that", "this", "there", "here",
  "find", "get", "show", "tell", "give",
  // Modals/auxiliaries: noise for both lexical match and embeddings.
  "should", "could", "would", "can", "shall", "may", "might", "must", "will",
]);

export function normalizeQuery(q: string, now = new Date()): NormalizedQuery {
  const original = q;
  const lower = q.toLowerCase();

  // Entities first (before stop-word stripping).
  const prNumbers = [...lower.matchAll(/pr\s*#?\s*(\d+)/g)].map((m) => m[1]);
  const fileRefs = extractFileRefs(q);

  // Temporal: relative + ISO.
  let after: string | undefined;
  let before: string | undefined;
  if (/\byesterday\b/.test(lower)) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - 1);
    d.setUTCHours(0, 0, 0, 0);
    after = d.toISOString();
  } else if (/\blast week\b/.test(lower)) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - 7);
    after = d.toISOString();
  }
  const lastNDays = lower.match(/\blast\s+(\d+)\s+days?\b/);
  if (lastNDays) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - Number(lastNDays[1]));
    after = d.toISOString();
  }
  if (/\bthis week\b/.test(lower)) {
    const d = new Date(now);
    const dow = (d.getUTCDay() + 6) % 7; // Monday start
    d.setUTCDate(d.getUTCDate() - dow);
    d.setUTCHours(0, 0, 0, 0);
    after = d.toISOString();
  }
  if (/\bthis month\b/.test(lower)) {
    const d = new Date(now);
    d.setUTCDate(1);
    d.setUTCHours(0, 0, 0, 0);
    after = d.toISOString();
  }
  const between = lower.match(/between\s+(\d{4}-\d{2}-\d{2})\s+and\s+(\d{4}-\d{2}-\d{2})/);
  if (between) {
    after = new Date(between[1]).toISOString();
    before = new Date(between[2]).toISOString();
  }
  const sinceMatch = lower.match(/\bsince\s+(\d{4}-\d{2}-\d{2})/);
  if (sinceMatch) after = new Date(sinceMatch[1]).toISOString();
  const beforeMatch = lower.match(/before\s+(\d{4}-\d{2}-\d{2})/);
  if (beforeMatch) before = new Date(beforeMatch[1]).toISOString();
  const afterMatch = lower.match(/after\s+(\d{4}-\d{2}-\d{2})/);
  if (afterMatch) after = new Date(afterMatch[1]).toISOString();

  // Index terms: alphanumeric, drop stop-words, keep order, dedupe.
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const t of lower.match(/[a-z0-9]+/g) ?? []) {
    if (t.length < 2 || STOP.has(t) || seen.has(t)) continue;
    seen.add(t);
    terms.push(t);
  }
  return { original, indexQuery: terms.join(" "), prNumbers, fileRefs, after, before };
}
