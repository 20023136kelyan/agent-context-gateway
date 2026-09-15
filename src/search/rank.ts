/**
 * Hybrid ranking with Reciprocal Rank Fusion (RRF, Cormack et al. 2009).
 * Fuses sparse lexical ranks and dense vector ranks:
 *   rrfBase = (1 / (k + rank_lex) + 1 / (k + rank_vec)) / maxPossible
 *
 * Then applies context boosts:
 *   final = max(0, 0.65*rrfBase + 0.10*project + 0.10*repo
 *               + 0.10*recency + 0.05*entity + feedbackDelta)
 */
import type { NormalizedQuery } from "./query.js";

const HALF_LIFE_DAYS = 30;
export const RRF_K = 10;

/**
 * Reciprocal Rank Fusion single-rank term normalized to [0, 1].
 * For rank = 1, returns 1.0. For higher ranks, decays reciprocally.
 * rank is 1-indexed. Returns 0 if rank <= 0 (unranked / not in top-K).
 */
export function rrfTerm(rank: number, k = RRF_K): number {
  if (rank <= 0 || !Number.isFinite(rank)) return 0;
  return (k + 1) / (k + rank);
}

/**
 * Maps raw cosine similarity (typically 0.45-0.80+ in Qwen/BGE models) into [0, 1] confidence weight.
 * Similarities near or below the background noise floor (~0.45) receive near-zero weight,
 * while genuine semantic matches (>=0.75) receive full weight.
 */
export function similarityWeight(sim?: number): number {
  if (sim === undefined || !Number.isFinite(sim)) return 0.0;
  return Math.max(0.0, Math.min(1.0, (sim - 0.45) / 0.30));
}

/**
 * Fused RRF base score combining sparse lexical rank and dense vector rank:
 * - Un-embedded documents or unranked hits are not penalized (max signal dominates).
 * - Vector rank is weighted by cosine similarity confidence so background noise cannot overtake top keyword hits.
 * - Consensus between both retrievers adds a reinforcement boost.
 */
export function rrfBaseScore(lexRank: number, vecRank: number, vecSim?: number, k = RRF_K): number {
  const sLex = rrfTerm(lexRank, k);
  const wVec = similarityWeight(vecSim);
  const sVec = wVec * rrfTerm(vecRank, k);
  const base = Math.max(sLex, sVec) + 0.15 * Math.min(sLex, sVec);
  return Math.min(1.0, base);
}

export function recencyScore(turnTs: string, nowMs: number): number {
  const t = Date.parse(turnTs);
  if (!Number.isFinite(t)) return 0;
  if (t >= nowMs) return 1;
  const ageDays = (nowMs - t) / 86_400_000;
  return Math.pow(0.5, ageDays / HALF_LIFE_DAYS);
}

export function entityScore(
  nq: NormalizedQuery,
  turnContent: string,
  turnFileRefs: string[],
): number {
  const hasEntities = nq.prNumbers.length > 0 || nq.fileRefs.length > 0;
  if (!hasEntities) return 0.5; // neutral when query names nothing specific
  const hay = `${turnContent}\n${turnFileRefs.join("\n")}`.toLowerCase();
  for (const pr of nq.prNumbers) {
    if (hay.includes(`#${pr}`) || hay.includes(`pr ${pr}`) || hay.includes(`pr${pr}`)) return 1;
  }
  for (const f of nq.fileRefs) {
    if (f && hay.includes(f.toLowerCase())) return 1;
  }
  return 0;
}

/** Final score: the RRF base (already in [0, 1]) plus context boosts, floored at 0. */
export function finalScore(
  rrfBase: number,
  projectMatch: boolean,
  turnTs: string,
  nq: NormalizedQuery,
  turnContent: string,
  turnFileRefs: string[],
  nowMs: number,
  repoMatch = false,
  feedbackDelta = 0,
): number {
  return Math.max(
    0,
    0.65 * rrfBase +
      0.1 * (projectMatch ? 1 : 0) +
      0.1 * (repoMatch ? 1 : 0) +
      0.1 * recencyScore(turnTs, nowMs) +
      0.05 * entityScore(nq, turnContent, turnFileRefs) +
      feedbackDelta,
  );
}
