/**
 * Reranker selection.
 *
 * Mirrors `src/embeddings/provider.ts`: a registry keyed by name,
 * first-available-wins, with key presence as the opt-in. Callers ask for "a
 * reranker" and never name a vendor.
 *
 * Order: jev → cross-encoder → none.
 *
 * Jev leads on measured quality, not assumption. On the fixture golden set,
 * identical lexical retrieval and differing only in reranker:
 *
 *   lexical                 NDCG@5 0.628   P@1 0.333
 *   cross-encoder           NDCG@5 0.702   P@1 0.533
 *   jev (pairwise)          NDCG@5 0.839   P@1 0.800
 *
 * Those figures are from the synthetic fixture corpus. Measured again on BEIR
 * nfcorpus — 3633 real documents nobody here wrote, 100 judged queries — the
 * ORDER held but the cross-encoder did not:
 *
 *   lexical                 NDCG@5 0.374    p50    6ms
 *   hybrid (no rerank)      NDCG@5 0.445    p50  318ms
 *   cross-encoder pool 10   NDCG@5 0.430    p50 2716ms
 *   cross-encoder pool 30   NDCG@5 0.433    p50 6984ms
 *   jev (pairwise)          NDCG@5 0.489    p50  620ms
 *
 * On realistic document lengths the cross-encoder lands BELOW plain hybrid
 * while costing seconds. Shrinking the pool cuts the latency and recovers none
 * of the quality, so it is not a budget problem — the model simply does not
 * help on this material. The fixture's short chat turns flattered it.
 *
 * Hence `rerankDefaultOn`: reranking is default-ON for Jev, which earns it, and
 * default-OFF for the cross-encoder, which does not. The cross-encoder remains
 * a legitimate explicit choice — local, deterministic, rate-limit free, nothing
 * leaves the machine — via GATEWAY_RERANKER=cross-encoder plus an explicit
 * `rerank` on the request.
 */
import { getSharedReranker, type CrossEncoderReranker } from "./rerank.js";
import { JevReranker } from "../judgments/rerank-jev.js";
import { VoyageReranker } from "./rerank-voyage.js";
import { jevAvailable } from "../judgments/jev.js";
import { voyageAvailable } from "../embeddings/voyage.js";

import type { RerankerName } from "../components.js";
export type { RerankerName } from "../components.js";

export type Reranker = Pick<CrossEncoderReranker, "rerank">;

/** Returns candidates untouched, flagged so callers can tell nothing happened. */
export const noopReranker: Reranker = {
  async rerank(_query, candidates, topK = 15) {
    return candidates.slice(0, topK).map((c) => ({
      id: c.id,
      originalScore: c.score,
      rerankScore: c.score,
      combinedScore: c.score,
      neural: false,
    }));
  },
};

export function rerankerAvailable(name: RerankerName): boolean {
  if (name === "jev") return jevAvailable();
  if (name === "voyage") return voyageAvailable();
  return true; // cross-encoder is in-process; none is trivially available
}

export function makeReranker(name: RerankerName): Reranker {
  if (name === "jev") return new JevReranker();
  if (name === "voyage") return new VoyageReranker();
  if (name === "cross-encoder") return getSharedReranker();
  return noopReranker;
}

// Voyage sits behind Jev (unmeasured as of writing) and ahead of the
// cross-encoder (measured below hybrid on real documents). Position is
// provisional until the reranker bake-off lands numbers.
import { RERANKER_ORDER as ORDER } from "../components.js";

/**
 * Which reranker this process will use when a request asks for reranking.
 * GATEWAY_RERANKER pins one; a pinned name is a hard selection and does not
 * fall back, so a deployment cannot silently switch vendors mid-corpus.
 */
/**
 * Should reranking happen when the caller expresses no preference?
 *
 * Reranker-aware rather than a blanket default, because the two rerankers
 * measure nothing alike on real documents (see above). A blanket default-on
 * gave keyless deployments multi-second searches for no measurable gain; a
 * blanket default-off gave everyone else 0.445 when 0.489 was available.
 *
 * An explicit `rerank` on the request always wins over this.
 */
export function rerankDefaultOn(name: RerankerName): boolean {
  return name === "jev";
}

export function resolveRerankerName(): RerankerName {
  const pinned = process.env.GATEWAY_RERANKER as RerankerName | undefined;
  if (pinned === "jev" || pinned === "voyage" || pinned === "cross-encoder" || pinned === "none") return pinned;
  return ORDER.find((n) => rerankerAvailable(n)) ?? "none";
}

export function resolveReranker(): { name: RerankerName; reranker: Reranker } {
  const name = resolveRerankerName();
  return { name, reranker: makeReranker(name) };
}
