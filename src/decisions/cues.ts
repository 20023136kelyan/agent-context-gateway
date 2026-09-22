/**
 * Decision cue taxonomy (heuristic recall layer).
 * Tiers exist so confidence is honest: strong cues conclude, weak cues suggest.
 *
 * Word lists live in ./locales (per language/domain pack); this file is the
 * locale-blind machinery. The exported names below resolve against the active
 * pack (GATEWAY_LOCALE, default en) so existing importers keep working.
 */
import { localePack } from "./locales/en.js";

const pack = localePack();

export const CONCLUSION_STRONG = pack.conclusionStrong;
export const CONCLUSION_WEAK = pack.conclusionWeak;
export const RATIONALE_CUES = pack.rationaleCues;
export const ALTERNATIVE_CUES = pack.alternativeCues;

const cueRegexes = new Map<string, RegExp | null>();

/** Compiled once per cue (extraction runs it per sentence of every turn). */
function cueRegex(cue: string): RegExp | null {
  const cached = cueRegexes.get(cue);
  if (cached !== undefined) return cached;
  // Whole-word match: "selected" must not fire inside "AXSelectedText".
  // Boundary only where the cue edge is a word char ("decision:" keeps
  // its colon; " vs " is trimmed first).
  const words = cue
    .trim()
    .split(/\s+/)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  let re: RegExp | null = null;
  if (words.length > 0 && words[0]) {
    const head = /^\w/.test(words[0]) ? "\\b" : "";
    const tail = /\w$/.test(words[words.length - 1]) ? "\\b" : "";
    try {
      re = new RegExp(`${head}${words.join("\\s+")}${tail}`, "g");
    } catch {
      re = null; // malformed cue — skip rather than break extraction
    }
  }
  cueRegexes.set(cue, re);
  return re;
}

export function countCues(text: string, cues: string[]): number {
  const lower = text.toLowerCase();
  let n = 0;
  for (const c of cues) {
    const re = cueRegex(c);
    if (re) n += lower.match(re)?.length ?? 0;
  }
  return n;
}

/**
 * Sentence-level cue hits. Sentences are naturally bounded (~a few hundred
 * chars), so the best-sentence count is length-normalized: one "decision" in
 * an 8KB plan doc scores 1, same as one in a 100-char verdict. Anchoring on
 * sentences (not whole turns) stops long docs from winning by verbosity.
 */
function splitSentences(text: string, maxSentences = 400): string[] {
  // Every newline is a boundary: TOC entries, tables and headings never form
  // mega-sentences that smuggle cues past the speaker/heading rules.
  return text.split(/\n+|(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean).slice(0, maxSentences);
}

export function sentenceHits(text: string, cues: string[], maxSentences = 400): { sentence: string; count: number }[] {
  const hits: { sentence: string; count: number }[] = [];
  for (const sentence of splitSentences(text, maxSentences)) {
    const count = countCues(sentence, cues);
    if (count > 0) hits.push({ sentence, count });
  }
  return hits;
}

/** Markdown headings announce; they don't conclude ("## 1.1 Final decision"). */
export function isHeading(sentence: string): boolean {
  return /^\s*(\d+[\).\:]?\s*)?#{1,6}\s/.test(sentence);
}

/**
 * Verb cues that double as adjectives ("the selected session", "the agreed
 * plan"). When immediately preceded by a determiner, the cue is attributive,
 * not a verdict — reject the sentence as an anchor.
 */
const VERB_CUES = pack.verbCues;
const DETERMINER_TAIL = new RegExp(pack.determinerTail);

const VERB_CUE_REGEXES = new Map(VERB_CUES.map((c) => [c, new RegExp(`\\b${c}\\b`)]));

export function isAttributiveUse(sentence: string, cues: string[]): boolean {
  const lower = sentence.toLowerCase();
  for (const c of cues) {
    const re = VERB_CUE_REGEXES.get(c);
    if (!re) continue;
    const idx = lower.search(re);
    if (idx < 0) continue;
    if (DETERMINER_TAIL.test(lower.slice(0, idx))) return true;
  }
  return false;
}

/**
 * Speech-act test: a conclusion needs a speaker (we/I/team/let's/our) or
 * terse colon form ("Decision: use Postgres"). Rejects adjective uses
 * ("the selected session") while keeping real verdicts.
 */
const SPEAKER_RE = new RegExp(pack.speakerPattern, "i");

export function hasSpeaker(sentence: string): boolean {
  if (/:/.test(sentence)) return true;
  return SPEAKER_RE.test(sentence);
}

/** Some sentence ends with "?" — not merely any "?" (optional chaining, URLs, regexes). */
export function isQuestion(text: string): boolean {
  return splitSentences(text).some((s) => s.endsWith("?"));
}

const WHY_RE = new RegExp(pack.whyPattern, "i");

/** "why"-style queries route to the decision path (no understanding needed). */
export function isWhyQuery(query: string): boolean {
  return WHY_RE.test(query);
}
