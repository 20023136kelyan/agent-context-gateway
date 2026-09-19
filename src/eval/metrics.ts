/**
 * Information Retrieval and Citation Evaluation Metrics.
 * Supports:
 * - NDCG@K (Normalized Discounted Cumulative Gain)
 * - MRR@K (Mean Reciprocal Rank)
 * - Precision@K / Recall@K
 * - ALCE-style Citation Precision & Recall for decision provenance
 */

export function dcgAtK(rankedIds: string[], relevantSet: Set<string>, k = 5): number {
  let dcg = 0;
  const count = Math.min(k, rankedIds.length);
  for (let i = 0; i < count; i++) {
    const isRel = relevantSet.has(rankedIds[i]) ? 1 : 0;
    if (isRel > 0) {
      dcg += (Math.pow(2, isRel) - 1) / Math.log2(i + 2); // i+2 since i is 0-indexed: log2(1 + (i+1))
    }
  }
  return dcg;
}

export function idcgAtK(numRelevant: number, k = 5): number {
  let idcg = 0;
  const count = Math.min(k, numRelevant);
  for (let i = 0; i < count; i++) {
    idcg += 1 / Math.log2(i + 2);
  }
  return idcg;
}

export function ndcgAtK(rankedIds: string[], relevantIds: string[], k = 5): number {
  const relSet = new Set(relevantIds);
  const dcg = dcgAtK(rankedIds, relSet, k);
  const idcg = idcgAtK(relSet.size, k);
  if (idcg === 0) return 1.0;
  return dcg / idcg;
}

export function mrrAtK(rankedIds: string[], relevantIds: string[], k = 5): number {
  const relSet = new Set(relevantIds);
  const count = Math.min(k, rankedIds.length);
  for (let i = 0; i < count; i++) {
    if (relSet.has(rankedIds[i])) {
      return 1 / (i + 1);
    }
  }
  return 0.0;
}

export function precisionAtK(rankedIds: string[], relevantIds: string[], k = 5): number {
  const relSet = new Set(relevantIds);
  const count = Math.min(k, rankedIds.length);
  if (count === 0) return 0.0;
  let matches = 0;
  for (let i = 0; i < count; i++) {
    if (relSet.has(rankedIds[i])) matches++;
  }
  return matches / count;
}

export interface CitationMetrics {
  citationPrecision: number;
  citationRecall: number;
}

/**
 * Evaluates cited turns from decision extraction (ALCE framework adaptation).
 * - Precision: fraction of cited turns that come from ground-truth relevant sessions.
 * - Recall: fraction of ground-truth relevant sessions cited in the decision.
 */
export function evaluateCitations(
  citedSessionIds: string[],
  groundTruthSessionIds: string[],
): CitationMetrics {
  const groundSet = new Set(groundTruthSessionIds);
  if (citedSessionIds.length === 0) {
    return { citationPrecision: groundSet.size === 0 ? 1 : 0, citationRecall: 0 };
  }
  let validCitations = 0;
  const citedUnique = new Set<string>();
  for (const sid of citedSessionIds) {
    if (groundSet.has(sid)) {
      validCitations++;
      citedUnique.add(sid);
    }
  }
  const citationPrecision = validCitations / citedSessionIds.length;
  const citationRecall = groundSet.size === 0 ? 1 : citedUnique.size / groundSet.size;
  return { citationPrecision, citationRecall };
}

/**
 * Is the TOP-ranked citation from a relevant session?
 *
 * Set-overlap citation precision cannot measure a decision judge. `decideOnce`
 * draws candidates from at most three sessions chosen upstream by search, and a
 * judge only reorders and rescores within that fixed set — it can never add or
 * remove a session. So the cited SET is identical whatever the judge does, and
 * precision/recall over it are constant across judges by construction.
 *
 * Rank position is the thing a judge actually controls, so that is what this
 * measures: 1 when one of the top-k cited sessions is relevant, else 0. An
 * empty citation list scores 0 — declining to answer is not precision.
 */
export function citationHitAtK(citedSessionIds: string[], groundTruthSessionIds: string[], k = 1): number {
  if (citedSessionIds.length === 0 || groundTruthSessionIds.length === 0) return 0;
  const ground = new Set(groundTruthSessionIds);
  return citedSessionIds.slice(0, k).some((id) => ground.has(id)) ? 1 : 0;
}
