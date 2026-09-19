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
 * Two deliberate acts are still required before a single byte leaves the
 * machine: a TYPESAFE_API_KEY must be present, AND the caller must pass
 * `rerank` on the request, which is default-off on every transport. Key
 * presence alone reranks nothing.
 *
 * The cross-encoder is not a fallback in the apologetic sense — it is local,
 * deterministic, rate-limit free, sends nothing anywhere, and runs at 53ms/pair
 * on commodity Intel hardware. A deployment that prefers it should say so with
 * GATEWAY_RERANKER=cross-encoder.
 */
import { getSharedReranker, type CrossEncoderReranker } from "./rerank.js";
import { JevReranker } from "../judgments/rerank-jev.js";
import { jevAvailable } from "../judgments/jev.js";

export type RerankerName = "jev" | "cross-encoder" | "none";

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
  return true; // cross-encoder is in-process; none is trivially available
}

export function makeReranker(name: RerankerName): Reranker {
  if (name === "jev") return new JevReranker();
  if (name === "cross-encoder") return getSharedReranker();
  return noopReranker;
}

const ORDER: RerankerName[] = ["jev", "cross-encoder"];

/**
 * Which reranker this process will use when a request asks for reranking.
 * GATEWAY_RERANKER pins one; a pinned name is a hard selection and does not
 * fall back, so a deployment cannot silently switch vendors mid-corpus.
 */
export function resolveRerankerName(): RerankerName {
  const pinned = process.env.GATEWAY_RERANKER as RerankerName | undefined;
  if (pinned === "jev" || pinned === "cross-encoder" || pinned === "none") return pinned;
  return ORDER.find((n) => rerankerAvailable(n)) ?? "none";
}

export function resolveReranker(): { name: RerankerName; reranker: Reranker } {
  const name = resolveRerankerName();
  return { name, reranker: makeReranker(name) };
}
