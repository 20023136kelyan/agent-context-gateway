/**
 * Reranker selection.
 *
 * Mirrors `src/embeddings/provider.ts`: a registry keyed by name,
 * first-available-wins, with key presence as the opt-in. Callers ask for "a
 * reranker" and never name a vendor. The rows themselves live in
 * `src/components.ts`.
 *
 * Order: jev → voyage → none. Both rerankers are remote; there is no local
 * model any more, so with neither key set the pool passes through untouched.
 *
 * Jev leads on measured quality, not assumption. On the fixture golden set,
 * identical lexical retrieval and differing only in reranker:
 *
 *   lexical                 NDCG@5 0.628   P@1 0.333
 *   cross-encoder           NDCG@5 0.702   P@1 0.533   (since deleted)
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
 * On realistic document lengths the local ONNX cross-encoder landed BELOW plain
 * hybrid while costing seconds, and shrinking the pool recovered none of the
 * quality. That result is why it was deleted rather than kept as a fallback.
 *
 * Jev is the locked reranker (`components.ts`) and leads the resolution order,
 * so the locked and resolved rerankers agree whenever TYPESAFE_API_KEY is set.
 * Voyage is pin-only until a bake-off against Jev on real agent history says
 * otherwise.
 */
import { JevReranker } from "../judgments/rerank-jev.js";
import { VoyageReranker } from "./rerank-voyage.js";
import { HttpReranker, httpRerankerConfig } from "./rerank-http.js";
import { jevAvailable } from "../judgments/jev.js";
import { voyageAvailable } from "../embeddings/voyage.js";

import { scrubText } from "../security/scrub.js";
import { focusOn, queryTerms } from "./focus.js";

import type { RerankerName } from "../components.js";
export type { RerankerName } from "../components.js";

/**
 * Shared reranker contract. It lives here, beside selection, so no single
 * vendor module owns the interface every reranker implements.
 */
export const RERANK_CONTENT_CHARS = 1000;

/**
 * What a reranker reads of a candidate, scrubbed before it is cut (a cut can
 * split a secret past recognition). GATEWAY_RERANK_INPUT=head reads the
 * turn's first RERANK_CONTENT_CHARS; focus reads the stretch of that length
 * holding the most query terms, as result windows do (search/focus.ts).
 * GATEWAY_RERANK_CHARS changes the length. Read per call, so eval arms can
 * differ per process.
 */
export function rerankText(content: string, query: string): string {
  const text = scrubText(content);
  const raw = Number(process.env.GATEWAY_RERANK_CHARS ?? RERANK_CONTENT_CHARS);
  const chars = Number.isFinite(raw) && raw >= 200 && raw <= 32000 ? Math.floor(raw) : RERANK_CONTENT_CHARS;
  return process.env.GATEWAY_RERANK_INPUT?.trim().toLowerCase() === "focus" ? focusOn(text, queryTerms(query), chars) : text.slice(0, chars);
}

/** Blend of model score and upstream retrieval score. */
export const RERANK_MODEL_WEIGHT = 0.6;

export interface RerankCandidate {
  id: string;
  content: string;
  score: number;
}

export interface RerankResult {
  id: string;
  originalScore: number;
  rerankScore: number;
  combinedScore: number;
  /** false when the model couldn't run and scores are the originals passed through. */
  neural: boolean;
}

export interface RerankerLike {
  rerank(query: string, candidates: RerankCandidate[], topK?: number): Promise<RerankResult[]>;
}

export type Reranker = Pick<RerankerLike, "rerank">;

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
  if (name === "self-hosted") return httpRerankerConfig() !== null;
  return true; // none is trivially available
}

export function makeReranker(name: RerankerName): Reranker {
  if (name === "jev") return new JevReranker();
  if (name === "voyage") return new VoyageReranker();
  if (name === "self-hosted") return new HttpReranker();
  return noopReranker;
}

import { RERANKER_ORDER as ORDER } from "../components.js";

/**
 * Should reranking happen when the caller expresses no preference?
 *
 * Off unless chosen. Judged on real agent history (README, "Reranker
 * bake-off"), no reranker lifted plain hybrid beyond noise, and Jev put a
 * worse session first more often than a better one (7 / 20). So a key alone
 * no longer turns reranking on. It runs by default when the user chose a
 * reranker (GATEWAY_RERANKER or `acg config set reranker`), or runs one they
 * host (GATEWAY_RERANK_URL); rerankByDefault (GATEWAY_RERANK_DEFAULT,
 * `acg config set rerank-default`) overrides either way.
 *
 * An explicit `rerank` on the request always wins over this.
 */
export function rerankDefaultOn(
  name: RerankerName,
  s: { reranker: RerankerName | null; rerankByDefault: boolean | null } = { reranker: null, rerankByDefault: null },
): boolean {
  if (name === "none") return false;
  if (s.rerankByDefault !== null) return s.rerankByDefault;
  return s.reranker !== null || name === "self-hosted";
}

/**
 * Which reranker this process will use when a request asks for reranking.
 * GATEWAY_RERANKER pins one; a pinned name is a hard selection and does not
 * fall back, so a deployment cannot silently switch vendors mid-corpus.
 */
export function resolveRerankerName(): RerankerName {
  const pinned = process.env.GATEWAY_RERANKER as RerankerName | undefined;
  if (pinned === "jev" || pinned === "voyage" || pinned === "self-hosted" || pinned === "none") return pinned;
  return ORDER.find((n) => rerankerAvailable(n)) ?? "none";
}

export function resolveReranker(): { name: RerankerName; reranker: Reranker } {
  const name = resolveRerankerName();
  return { name, reranker: makeReranker(name) };
}
