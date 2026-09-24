/**
 * Which part of a long text to show when only maxChars of it fit: the stretch
 * holding the most query terms. Used by result windows (search.ts fitWindow)
 * and by what a reranker reads of a candidate (reranker.ts rerankText).
 */
import { normalizeQuery } from "./query.js";

/** The words of a query that focusOn looks for (index form, longer than 2 chars). */
export function queryTerms(query: string): string[] {
  return normalizeQuery(query).indexQuery.toLowerCase().split(" ").filter((t) => t.length > 2);
}

/** The maxChars stretch of text holding the most query-term occurrences; its start when none occur. */
export function focusOn(text: string, terms: string[], maxChars: number): string {
  if (text.length <= maxChars) return text;
  const lower = text.toLowerCase();
  const hits: number[] = [];
  for (const t of terms) {
    for (let i = lower.indexOf(t); i >= 0 && hits.length < 5000; i = lower.indexOf(t, i + t.length)) hits.push(i);
  }
  hits.sort((a, b) => a - b);
  const span = maxChars - 2; // room for the two ellipses
  const lead = Math.floor(span / 4); // text leading into the match stays
  let best = 0;
  let bestCount = 0;
  for (let i = 0, k = 0; i < hits.length; i++) {
    const from = Math.max(0, hits[i]! - lead);
    if (k < i) k = i;
    while (k < hits.length && hits[k]! < from + span) k++;
    if (k - i > bestCount) {
      bestCount = k - i;
      best = from;
    }
  }
  const from = Math.min(best, text.length - span);
  return `${from > 0 ? "…" : ""}${text.slice(from, from + span)}${from + span < text.length ? "…" : ""}`;
}
