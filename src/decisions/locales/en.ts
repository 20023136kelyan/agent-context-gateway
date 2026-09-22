/**
 * English (software-jargon) decision cue pack.
 *
 * THE language- and domain-specific half of decision extraction. Everything
 * here is word lists and one grammar pattern; the machinery (splitting,
 * matching, anchoring, scoring) lives in ../cues.ts and is locale-blind.
 * A French pack, a legal-domain pack, a medical pack: same interface, new
 * words, zero machinery changes. Select with GATEWAY_LOCALE (default "en").
 */
export interface LocalePack {
  conclusionStrong: string[];
  conclusionWeak: string[];
  rationaleCues: string[];
  alternativeCues: string[];
  /** Verb cues that double as adjectives ("the selected session"). */
  verbCues: string[];
  /** Determiners marking attributive use, as a regex tail (lowercase). */
  determinerTail: string;
  /** Speaker pattern: who must own a verdict (regex body, case-insensitive). */
  speakerPattern: string;
  /** Why-query routing pattern (regex body, case-insensitive). */
  whyPattern: string;
}

export const enPack: LocalePack = {
  conclusionStrong: [
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
    // "chose"/"choose": the audit's most common real-verb miss.
    "chose",
    "choose",
    "selected",
    "settled on",
    "locked in",
  ],
  // "recommendation" is the noun form the verb list missed. "going to" was
  // tried and reverted (fires on every intent statement, floods the top-6).
  conclusionWeak: ["should", "probably", "lean toward", "leaning toward", "prefer", "recommend", "recommendation", "suggest we"],
  rationaleCues: [
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
  ],
  alternativeCues: ["instead of", "rather than", "alternative", "considered", "option", "versus", " vs ", "vs.", "on the other hand"],
  verbCues: ["selected", "chosen", "preferred", "agreed"],
  determinerTail: "(?:the|a|an|this|that|these|those|its|their|his|her|my|your)\\s+$",
  speakerPattern: "\\b(we|i|team|let's|lets|our|we've|we have|i've|i have|my|your)\\b",
  whyPattern: "\\b(why|reason|decide|decided|decision|choose|chose|choice|reject|prefer)\\b",
};

const PACKS: Record<string, LocalePack> = { en: enPack };

/** Active pack by GATEWAY_LOCALE; unknown locales fall back to English. */
export function localePack(): LocalePack {
  return PACKS[process.env.GATEWAY_LOCALE ?? "en"] ?? enPack;
}
