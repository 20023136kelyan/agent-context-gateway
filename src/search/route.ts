/**
 * Retrieval router (Jev-branch experiment).
 *
 * Decides PER QUERY whether semantic retrieval is worth its cost, instead of
 * running every query through the full hybrid pipeline. Two stages:
 *
 *   1. Deterministic entity fast path (free): queries dominated by PR numbers
 *      or file refs are exact-lookup tasks — vectors add noise, not recall.
 *   2. Jev strategy judgment: a Noul asks whether keyword match will suffice.
 *      Unavailable/offline (no key, fetch failure) falls through to hybrid,
 *      so the router can only save work, never deny retrieval.
 *
 * The router does NOT pick rerankers or judges — it answers one question:
 * does this query need vectors in the pool? Measured against always-hybrid
 * on NDCG parity plus the share of queries spared the embedding call.
 */
import { normalizeQuery } from "./query.js";
import { isWhyQuery } from "../decisions/cues.js";

export interface RetrievalPlan {
  semantic: boolean;
  /** Why: entity | jev:<p> | default-hybrid | jev-unavailable. For eval analysis. */
  reason: string;
}

export async function planRetrieval(query: string): Promise<RetrievalPlan> {
  const nq = normalizeQuery(query);
  const termCount = nq.indexQuery.split(" ").filter(Boolean).length;

  // Exact-lookup tasks: the answer names its identifier. Vectors can only
  // dilute an already-precise lexical match.
  if ((nq.prNumbers.length > 0 || nq.fileRefs.length > 0) && termCount <= 5) {
    return { semantic: false, reason: "entity" };
  }

  // Strategy judgment for everything else.
  try {
    const { httpJevClient } = await import("../judgments/jev.js");
    const { answers } = await httpJevClient.noul(
      { query },
      {
        needs_semantics: {
          instructions: "Will keyword search alone find the answer to `query`, or does it need meaning-level matching?",
          criteria: {
            true: "The query and the answer likely share few or no exact words (paraphrases, symptoms, descriptions of behavior).",
            false: "The query names distinctive terms, identifiers, paths, or phrases the answer certainly repeats.",
          },
        },
      },
    );
    const v = answers.needs_semantics;
    if (typeof v === "number") {
      return { semantic: v >= 0.5, reason: `jev:${v.toFixed(2)}` };
    }
  } catch {
    // No key, offline, timeout — fall through to full retrieval.
  }
  return { semantic: true, reason: "default-hybrid" };
}

/**
 * Deterministic policy (W4 brief #4 hypothesis): zero network, pure string
 * ops. Entity-dominated or very short queries are exact-lookup tasks;
 * why-worded queries target verdicts whose wording rarely overlaps the query
 * (the paraphrase-shaped hole), so they always get vectors. Expectation: ≥30%
 * skip the embedding call at <0.01 overall NDCG@5 loss vs always-hybrid.
 */
export function planRetrievalDeterministic(query: string): RetrievalPlan {
  const nq = normalizeQuery(query);
  const termCount = nq.indexQuery.split(" ").filter(Boolean).length;
  if (nq.prNumbers.length > 0 || nq.fileRefs.length > 0) {
    return { semantic: false, reason: "det-entity" };
  }
  if (isWhyQuery(query)) {
    return { semantic: true, reason: "det-why" };
  }
  if (termCount <= 3) {
    return { semantic: false, reason: "det-short" };
  }
  return { semantic: true, reason: "det-hybrid" };
}
