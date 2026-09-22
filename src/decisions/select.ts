/**
 * Decision-judge selection.
 *
 * Mirrors `src/search/reranker.ts`. Order: jev -> neural-judge.
 * `GATEWAY_JUDGE` pins one; a pin never falls back.
 *
 * Unlike reranking there is no per-request opt-in for `decide` yet, so a Jev key
 * alone changes which judge runs. That is why the default order still ends at
 * the local cross-encoder, and why `decide` surfaces `method` on every verdict:
 * a caller can always see which judge produced a claim.
 */
import type { DecisionJudge } from "./extract.js";
import { NeuralEntailmentJudge } from "./extract.js";
import { JevDecisionJudge } from "../judgments/judge-jev.js";
import { jevAvailable } from "../judgments/jev.js";

import type { JudgeName } from "../components.js";
export type { JudgeName } from "../components.js";

export function makeJudge(name: JudgeName): DecisionJudge {
  return name === "jev" ? new JevDecisionJudge() : new NeuralEntailmentJudge();
}

export function resolveJudgeName(): JudgeName {
  const pinned = process.env.GATEWAY_JUDGE as JudgeName | undefined;
  if (pinned === "jev" || pinned === "neural-judge") return pinned;
  return jevAvailable() ? "jev" : "neural-judge";
}

export function resolveJudge(): DecisionJudge {
  return makeJudge(resolveJudgeName());
}
