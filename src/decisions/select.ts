/**
 * Decision-judge selection.
 *
 * Mirrors `src/search/reranker.ts`. Order: jev -> heuristic passthrough.
 * `GATEWAY_JUDGE` pins one; a pin never falls back.
 *
 * Unlike reranking there is no per-request opt-in for `decide` yet, so a Jev key
 * alone changes which judge runs. Without one, verdicts stand as heuristic
 * candidates and say so via their method label: a caller can always see which
 * judge produced a claim.
 */
import type { DecisionJudge } from "./extract.js";
import { HeuristicJudge } from "./extract.js";
import { JevDecisionJudge } from "../judgments/judge-jev.js";
import { jevAvailable } from "../judgments/jev.js";

import type { JudgeName } from "../components.js";
export type { JudgeName } from "../components.js";

export function makeJudge(name: JudgeName): DecisionJudge {
  if (name === "heuristic") return new HeuristicJudge();
  return new JevDecisionJudge();
}

export function resolveJudgeName(): JudgeName {
  const pinned = process.env.GATEWAY_JUDGE as JudgeName | undefined;
  if (pinned === "jev" || pinned === "heuristic") return pinned;
  return jevAvailable() ? "jev" : "heuristic";
}

export function resolveJudge(): DecisionJudge {
  return makeJudge(resolveJudgeName());
}
