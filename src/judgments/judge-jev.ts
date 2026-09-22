/**
 * Jev decision judge.
 *
 * The precision stage of `context.decide`. It replaced `NeuralEntailmentJudge`
 * (since deleted), and not merely as a speed or quality swap: that judge ran a
 * *relevance reranker* and called its output *entailment*. Relevance and
 * "does this answer the question" are different questions, and the reranker was
 * never trained on the second one. A Noul asks it directly.
 *
 * Two judgments per candidate, both typed:
 *
 *   Noul  — does this passage actually answer the query?
 *   Score — is this proposed, decided, or reversed?
 *
 * The Score exists because the heuristic extractor matches conclusion-SHAPED
 * language and cannot tell a proposal from an outcome. On the fixture corpus
 * one session restates every decision topic and closes with "No conclusions yet
 * on any of these" — textbook decision shape, zero decision content. Damping
 * `proposed` is what pushes that out of the citations.
 *
 * Privacy: sends the query plus candidate conclusions and rationale off-machine.
 * See `jev.ts`; the same opt-in rules apply.
 */
import type { DecisionJudge, DecisionMethod, DecisionState, ExtractedDecision } from "../decisions/extract.js";
import { httpJevClient, type JevClient } from "./jev.js";

/** The blend NeuralEntailmentJudge used, kept so the judge duels compared models, not blends. */
const MODEL_WEIGHT = 0.65;

/** A proposal that answers nothing should not outrank a real decision. */
const PROPOSED_DAMPING = 0.5;

const STATE_LEVELS = [
  "The passage raises, proposes or schedules the topic without settling it.",
  "The passage records a decision that was actually made.",
  "The passage reverses or supersedes a decision made earlier.",
] as const;

const STATES: DecisionState[] = ["proposed", "decided", "reversed"];

export class JevDecisionJudge implements DecisionJudge {
  readonly method: DecisionMethod = "jev";

  constructor(
    private client: JevClient = httpJevClient,
    /** Off makes this a pure Noul judge, for measuring the Score's contribution alone. */
    private useState = true,
  ) {}

  async judge(candidates: ExtractedDecision[], query?: string): Promise<ExtractedDecision[]> {
    if (!query || candidates.length === 0) return candidates;
    try {
      // Pairwise, for the reason the reranker measured: splitting one context
      // across many candidates cost each judgment its focused attention. One
      // mixed request per candidate (Noul + Score together, as TypeSafe
      // prescribes) instead of two: same judgments, half the requests.
      const judged = await Promise.all(
        candidates.map(async (c) => {
          const passage = `${c.conclusion.content}\nRationale: ${c.rationale.map((r) => r.content).join(" ")}`;
          const state = { query, passage };

          const res = await this.client.evaluate(state, {
            answers_query: {
              instructions: "Does `passage` state the decision or reason that answers `query`?",
              criteria: {
                true: "The passage settles the question the query asks about, and says what was chosen or why.",
                false: "The passage is on the topic but leaves it open, or discusses it without resolving it.",
              },
            },
            ...(this.useState
              ? {
                  decision_state: {
                    instructions: "How settled is the decision described in `passage`?",
                    levels: [...STATE_LEVELS],
                  },
                }
              : {}),
          });
          const answers = res.nouls.answers_query;
          const level = res.scores.decision_state;
          return { c, noul: typeof answers === "number" ? answers : undefined, level };
        }),
      );

      // Nothing scored: leave the heuristic verdicts alone AND unrelabelled, so
      // `method` never claims a judgment that did not happen.
      if (!judged.some((j) => j.noul !== undefined)) return candidates;

      const out = judged.map(({ c, noul, level }) => {
        if (noul === undefined) return c;
        const decisionState =
          typeof level === "number" && level >= 0 && level < STATES.length ? STATES[level] : undefined;
        let conf = MODEL_WEIGHT * noul + (1 - MODEL_WEIGHT) * c.confidence;
        if (decisionState === "proposed") conf *= PROPOSED_DAMPING;
        return {
          ...c,
          method: "jev" as const,
          ...(decisionState ? { decisionState } : {}),
          confidence: Number(conf.toFixed(3)),
        };
      });

      out.sort((a, b) => b.confidence - a.confidence);
      return out;
    } catch {
      return candidates;
    }
  }
}
