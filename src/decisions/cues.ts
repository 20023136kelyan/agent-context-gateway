/**
 * Decision cue taxonomy (heuristic recall layer).
 * Tiers exist so confidence is honest: strong cues conclude, weak cues suggest.
 */
export const CONCLUSION_STRONG = [
  "we decided",
  "decided to",
  "decision:",
  "decision is",
  "agreed to",
  "agreement:",
  "going with",
  "we'll use",
  "we will use",
  "let's go with",
  "lets go with",
  "final call",
  "final decision",
  "chosen",
  "selected",
  "settled on",
  "locked in",
];

export const CONCLUSION_WEAK = ["should", "probably", "lean toward", "leaning toward", "prefer", "recommend", "suggest we"];

export const RATIONALE_CUES = [
  "because",
  "since",
  "reason is",
  "reason:",
  "rationale",
  "tradeoff",
  "trade-off",
  "given that",
  "in order to",
  "so that",
  "avoids",
  "benefit",
];

export const ALTERNATIVE_CUES = ["instead of", "rather than", "alternative", "considered", "option", "versus", " vs ", "vs.", "on the other hand"];

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
export function sentenceHits(text: string, cues: string[], maxSentences = 400): { sentence: string; count: number }[] {
  // Every newline is a boundary: TOC entries, tables and headings never form
  // mega-sentences that smuggle cues past the speaker/heading rules.
  const sentences = text.split(/\n+|(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean).slice(0, maxSentences);
  const hits: { sentence: string; count: number }[] = [];
  for (const sentence of sentences) {
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
const VERB_CUES = ["selected", "chosen", "preferred", "agreed"];
const DETERMINER_TAIL = /(?:the|a|an|this|that|these|those|its|their|his|her|my|your)\s+$/;

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
export function hasSpeaker(sentence: string): boolean {
  if (/:/.test(sentence)) return true;
  return /\b(we|i|team|let's|lets|our|we've|we have|i've|i have)\b/i.test(sentence);
}

export function isQuestion(text: string): boolean {
  return text.includes("?");
}

/** "why"-style queries route to the decision path (no understanding needed). */
export function isWhyQuery(query: string): boolean {
  return /\b(why|reason|decide|decided|decision|choose|chose|choice|reject|prefer)\b/i.test(query);
}
