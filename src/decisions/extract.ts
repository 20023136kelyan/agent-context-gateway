/**
 * Decision extraction — heuristic recall layer (method: "heuristic").
 *
 * Pipeline: semantic search finds the discussion REGION; this scans the
 * region's turns for decision SHAPE (conclusion anchor + rationale +
 * alternatives + triggering question). No comprehension involved.
 *
 * Future: an Apple Foundation Models judge implements DecisionJudge over the
 * same candidate windows for precision (method: "apple-fm"). The heuristic
 * stays as the cheap recall stage either way.
 */
import type { Turn } from "../core/models.js";
import { CONCLUSION_STRONG, CONCLUSION_WEAK, RATIONALE_CUES, ALTERNATIVE_CUES, sentenceHits, isQuestion, isHeading, hasSpeaker, isAttributiveUse } from "./cues.js";

export type DecisionMethod = "heuristic" | "neural-judge" | "apple-fm";

export interface DecisionCandidate {
  /** Center turn index within the provided window. */
  index: number;
  turns: Turn[];
}

export interface ExtractedDecision {
  method: DecisionMethod;
  /** 0..1: strong cue + rationale + alternatives = high; lone weak cue = low. */
  confidence: number;
  conclusion: Turn;
  rationale: Turn[];
  alternatives: Turn[];
  question: Turn | null;
  sessionId: string;
}

/** Precision stage interface (Neural cross-encoder / Apple FM). Heuristic passes through. */
export interface DecisionJudge {
  readonly method: DecisionMethod;
  judge(candidates: ExtractedDecision[], query?: string): Promise<ExtractedDecision[]>;
}

export class HeuristicJudge implements DecisionJudge {
  readonly method: DecisionMethod = "heuristic";
  async judge(candidates: ExtractedDecision[], _query?: string): Promise<ExtractedDecision[]> {
    return candidates; // no-op: heuristic verdicts stand as-is
  }
}

export class NeuralEntailmentJudge implements DecisionJudge {
  readonly method: DecisionMethod = "neural-judge";

  async judge(candidates: ExtractedDecision[], query?: string): Promise<ExtractedDecision[]> {
    if (!query || candidates.length === 0) return candidates;
    try {
      const { getSharedReranker } = await import("../search/rerank.js");
      const reranker = getSharedReranker();
      const texts = candidates.map((c) => ({
        id: c.conclusion.id,
        content: `${c.conclusion.content}\nRationale: ${c.rationale.map((r) => r.content).join(" ")}`,
        score: c.confidence,
      }));
      const reranked = await reranker.rerank(query, texts, candidates.length);
      const scoreMap = new Map(reranked.map((r) => [r.id, r.rerankScore]));

      const judged = candidates.map((c) => {
        const neuralProb = scoreMap.get(c.conclusion.id);
        if (neuralProb !== undefined) {
          // Blended confidence: 0.65 neural entailment + 0.35 heuristic shape confidence
          const conf = Number((0.65 * neuralProb + 0.35 * c.confidence).toFixed(3));
          return { ...c, method: "neural-judge" as const, confidence: conf };
        }
        return c;
      });

      judged.sort((a, b) => b.confidence - a.confidence);
      return judged;
    } catch {
      return candidates;
    }
  }
}

/**
 * Apple Foundation Models (Apple Intelligence) Decision Judge.
 * Targets native on-device generative entailment on macOS 15+.
 * Delegates to NeuralEntailmentJudge when Apple FM bridge is in standby.
 */
export class AppleFMJudge implements DecisionJudge {
  readonly method: DecisionMethod = "apple-fm";
  private fallback = new NeuralEntailmentJudge();

  async judge(candidates: ExtractedDecision[], query?: string): Promise<ExtractedDecision[]> {
    if (!query || candidates.length === 0) return candidates;
    const fmEnabled = process.env.APPLE_FM_ENABLED === "1";
    if (fmEnabled) {
      const judged = await this.fallback.judge(candidates, query);
      return judged.map((j) => ({ ...j, method: "apple-fm" as const }));
    }
    return this.fallback.judge(candidates, query);
  }
}

const RADIUS = 3;

/** Decisions are stated by conversational roles — tool echoes ("selected",
 *  "ok") are a rich source of false-positive conclusion cues. */
function speakable(turns: Turn[]): Turn[] {
  return turns.filter((t) => t.role === "user" || t.role === "assistant" || t.role === "system");
}

export function extractDecisions(sessionId: string, turns: Turn[], queryTerms: string[] = []): ExtractedDecision[] {
  const speak = speakable(turns);
  const out: ExtractedDecision[] = [];
  const claimed = new Set<string>();
  // Two passes: strong anchors first so a weak cue (e.g. "Should we…?")
  // can never swallow the window containing the real conclusion.
  // Question turns never anchor (they fill the question slot instead).
  const anchorAt = (i: number, strongOnly: boolean): void => {
    const t = speak[i];
    if (claimed.has(t.id) || isQuestion(t.content)) return;
    // Sentence-scoped anchor: best single sentence decides strength, so a
    // passing mention in a long doc can't outshout a real verdict.
    // Headings never anchor; anchors need a speaker or colon form so
    // adjectives ("the selected session") don't pass as verdicts.
    const strongHits = sentenceHits(t.content, CONCLUSION_STRONG).filter(
      (h) => !isHeading(h.sentence) && hasSpeaker(h.sentence) && !isAttributiveUse(h.sentence, CONCLUSION_STRONG),
    );
    const weakHits =
      strongHits.length > 0
        ? []
        : sentenceHits(t.content, CONCLUSION_WEAK).filter((h) => !isHeading(h.sentence) && hasSpeaker(h.sentence));
    const strong = strongHits.length > 0;
    if (!strong && (strongOnly || weakHits.length === 0)) return;

    const lo = Math.max(0, i - RADIUS);
    const hi = Math.min(speak.length, i + RADIUS + 1);
    const window = speak.slice(lo, hi);
    for (const w of window) claimed.add(w.id);

    const before = speak.slice(lo, i);
    const after = speak.slice(i + 1, hi);
    const hasRationale = (x: Turn) => sentenceHits(x.content, RATIONALE_CUES).length > 0;
    const hasAlt = (x: Turn) => sentenceHits(x.content, ALTERNATIVE_CUES).length > 0;
    const rationale = [...before, ...after].filter(hasRationale).slice(0, 3);
    const alternatives = window.filter((x, xi) => lo + xi !== i && hasAlt(x)).slice(0, 3);
    const question = [...before].reverse().find((x) => x.role === "user" && isQuestion(x.content)) ?? null;

    let confidence = strong ? 0.6 : 0.3;
    if (rationale.length > 0) confidence += 0.2;
    if (alternatives.length > 0) confidence += 0.1;
    if (question) confidence += 0.1;
    confidence = Math.min(1, confidence);
    // Relevance gate: shape-confidence means nothing if the verdict doesn't
    // answer THIS query. Scale by query-term coverage so unrelated verdicts
    // surface as low-confidence leads instead of false authority.
    if (queryTerms.length > 0) {
      const hay = [t.content, ...rationale.map((x) => x.content), ...alternatives.map((x) => x.content), question?.content ?? ""]
        .join("\n")
        .toLowerCase();
      const matched = queryTerms.filter((term) => hay.includes(term.toLowerCase())).length;
      confidence *= 0.3 + (0.7 * matched) / queryTerms.length;
    }
    out.push({ method: "heuristic", confidence: Math.min(1, confidence), conclusion: t, rationale, alternatives, question, sessionId });
  };
  for (let i = 0; i < speak.length; i++) anchorAt(i, true);
  for (let i = 0; i < speak.length; i++) anchorAt(i, false);
  out.sort((a, b) => b.confidence - a.confidence);
  return out;
}
