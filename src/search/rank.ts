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

/** Recency half-life: a turn this many days old scores half a fresh one.
 *
 * 30 days from the original hybrid ranking — recent work outranks last
 * month's without erasing it.
 *
 * Overridable with GATEWAY_HALFLIFE_DAYS; invalid values fall back to the default. */
export const HALF_LIFE_DAYS = (() => {
  const raw = Number(process.env.GATEWAY_HALFLIFE_DAYS ?? 30);
  return Number.isFinite(raw) && raw > 0 ? raw : 30;
})();
/** RRF damping factor: lower k rewards top ranks more steeply.
 *
 * 10, not the classic 60 — with only two fused lists (lexical + vector) the
 * smaller k keeps rank-1 agreement decisive instead of washing it out.
 *
 * Overridable with GATEWAY_RRF_K; invalid values fall back to the default. */
export const RRF_K = (() => {
  const raw = Number(process.env.GATEWAY_RRF_K ?? 10);
  return Number.isFinite(raw) && raw >= 1 && raw <= 100 ? Math.floor(raw) : 10;
})();

/** Final-score blend weights. Defaults are the hand-tuned blend from the
 * original finalScore (0.65 RRF + 0.10 project + 0.10 repo + 0.10 recency +
 * 0.05 entity) that the pooled-judging eval isolates against the reranker.
 *
 * Each overridable with its GATEWAY_W_* var (0..1); invalid values fall back
 * to the default for that weight only. */
function envWeight(name: string, def: number): number {
  const raw = Number(process.env[name] ?? def);
  return Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : def;
}
export const RANK_WEIGHTS = {
  rrf: envWeight("GATEWAY_W_RRF", 0.65),
  project: envWeight("GATEWAY_W_PROJECT", 0.1),
  repo: envWeight("GATEWAY_W_REPO", 0.1),
  recency: envWeight("GATEWAY_W_RECENCY", 0.1),
  entity: envWeight("GATEWAY_W_ENTITY", 0.05),
};

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
 * Maps raw cosine similarity into a [0, 1] confidence weight.
 *
 * The floor and span are ENGINE-CALIBRATED, not universal. The original
 * 0.45/0.30 came from Qwen/BGE, whose similarities run 0.45-0.80. Voyage-4
 * compresses that range: measured on the fixture corpus, paraphrase targets
 * sitting at vector rank 1 score 0.35-0.57. Under the BGE calibration five of
 * those ten scored a weight of EXACTLY ZERO — retrieved at rank 1, admitted
 * through MIN_VECTOR_SIM, then multiplied out of existence before fusion,
 * while any lexical distractor at rank 1 carried full weight 1.0.
 *
 * That is why paraphrase recall@60 was 0.95 while recall@1 was 0.15: the
 * candidates were always there and the fusion could not see them.
 *
 * Tunable per engine: GATEWAY_SIM_FLOOR / GATEWAY_SIM_SPAN. Invalid values
 * fall back to the defaults rather than silently disabling the weighting.
 */
const SIM_FLOOR = (() => {
  const raw = Number(process.env.GATEWAY_SIM_FLOOR ?? 0.15);
  return Number.isFinite(raw) && raw >= 0 && raw < 1 ? raw : 0.15;
})();
export { SIM_FLOOR };
const SIM_SPAN = (() => {
  const raw = Number(process.env.GATEWAY_SIM_SPAN ?? 0.35);
  return Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : 0.35;
})();
export { SIM_SPAN };

export function similarityWeight(sim?: number): number {
  if (sim === undefined || !Number.isFinite(sim)) return 0.0;
  return Math.max(0.0, Math.min(1.0, (sim - SIM_FLOOR) / SIM_SPAN));
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
    RANK_WEIGHTS.rrf * rrfBase +
      RANK_WEIGHTS.project * (projectMatch ? 1 : 0) +
      RANK_WEIGHTS.repo * (repoMatch ? 1 : 0) +
      RANK_WEIGHTS.recency * recencyScore(turnTs, nowMs) +
      RANK_WEIGHTS.entity * entityScore(nq, turnContent, turnFileRefs) +
      feedbackDelta,
  );
}
