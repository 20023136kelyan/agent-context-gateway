/**
 * Query facets: a long prompt searched as its parts as well as its whole.
 *
 * The proactive hook's queries, and every mined real-history query, are an
 * agent session's opening prompt: often a paragraph that names a file, pastes
 * an error, mentions a function and describes the problem in prose. Searched
 * as one BM25 query, the prose dilutes the error text and the error text
 * dilutes the prose. LoCoMo-Conv (arXiv 2609.03467) measured implicit,
 * context-driven queries 40-50% below direct ones in recall, and searching
 * several phrasings added up to ~15 points for systems that store raw turns,
 * as this one does. Those phrasings came from an LLM; these are cut out of the
 * prompt itself, so nothing is generated:
 *
 *   files        paths and file names the prompt mentions
 *   errors       lines that look like error output
 *   identifiers  camelCase, snake_case and dotted names
 *   opening      the first sentence: usually the ask itself
 *
 * Each facet is its own ranked list, fused by best rank with the whole query's
 * (search.ts), so a facet's top hit competes with the prompt's top hit rather
 * than trailing every one of its hits.
 *
 * On by default (roadmap 11c). Against mined labels it lifted NDCG@5 by about
 * +0.02 and the proactive hook's precision (0.651 -> 0.674, false alarms
 * 0.211 -> 0.158); two LLM judges found no difference either way (README,
 * "Judged relevance"). It costs no measurable latency. GATEWAY_FACETS=off turns it off.
 */
import { extractFileRefs } from "../adapters/text.js";

export const facetsEnabled = (): boolean => !/^(off|0|false|no)$/i.test(process.env.GATEWAY_FACETS ?? "");

/** Shorter prompts are already one facet. */
const MIN_WORDS = 20;
/** Error output, not prose about an error: a typed error, a compiler code, a CLI failure marker. */
// Case-sensitive on purpose: with /i, `E[A-Z]{3,}` (ENOENT, EACCES) matches any word starting with "e".
const ERROR_LINE = /\b[A-Z]\w*(?:Error|Exception)\b|^\s*(?:[Ee]rror|ERROR|[Ff]atal|FATAL|[Pp]anic|Traceback|[Ww]arning)\b|\bTS\d{4}\b|\bE[A-Z]{3,}\b|npm ERR!|^\s*FAIL\b|\bexit(?:ed with)? code [1-9]/;
const IDENTIFIER = /\b(?:[a-z]+(?:[A-Z][a-z0-9]*)+|[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+|[a-z0-9]+(?:_[a-z0-9]+)+|[a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)+)\b/g;

export interface QueryFacet {
  kind: "files" | "errors" | "identifiers" | "opening";
  text: string;
}

export function queryFacets(prompt: string): QueryFacet[] {
  const words = prompt.trim().split(/\s+/).filter(Boolean);
  if (words.length < MIN_WORDS) return [];
  const out: QueryFacet[] = [];

  const files = extractFileRefs(prompt).map((f) => f.split("/").pop() ?? f);
  if (files.length) out.push({ kind: "files", text: [...new Set(files)].slice(0, 8).join(" ") });

  const errors = prompt
    .split("\n")
    .map((l) => l.trim())
    // A line of prose that ends in pasted output: keep the output.
    .map((l) => l.replace(/^.*?(?=\b[A-Z]\w*(?:Error|Exception)\b)/, ""))
    .filter((l) => l.length >= 8 && ERROR_LINE.test(l))
    .slice(0, 3)
    .map((l) => l.slice(0, 200));
  if (errors.length) out.push({ kind: "errors", text: errors.join(" ") });

  const fileSet = new Set(extractFileRefs(prompt));
  const ids = [...new Set([...prompt.matchAll(IDENTIFIER)].map((m) => m[0]))]
    // A path's pieces are the files facet; version numbers are not names.
    .filter((id) => !fileSet.has(id) && !/^\d/.test(id) && !/^(e\.g|i\.e|etc)$/i.test(id) && !/\.[a-z]{1,4}$/.test(id))
    .slice(0, 8);
  if (ids.length >= 2) out.push({ kind: "identifiers", text: ids.join(" ") });

  const opening = /^[\s\S]*?[.?!](\s|$)/.exec(prompt.trim())?.[0].trim();
  const openingWords = opening?.split(/\s+/).length ?? 0;
  if (opening && openingWords >= 4 && openingWords < words.length) out.push({ kind: "opening", text: opening });

  return out;
}
