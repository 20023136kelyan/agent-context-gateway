/**
 * Component registry: the single source of truth for every swappable piece
 * of the retrieval pipeline (embedding engines, rerankers, decision judges).
 *
 * Adding a component used to mean touching six files (union type, factory,
 * order, settings allow-list, table naming, eval arms). Now: one row here
 * plus its factory entry. Types, orders, allow-lists and cost basis all
 * derive from these tables — `gateway models` prints them for operators.
 *
 * `locked` marks the measured production stack. Anything unlocked is a
 * fallback, experiment, or deprecated path: resolvable when pinned, never
 * default, excluded from sweeps unless named.
 */
export interface EngineDef {
  readonly name: string;
  /** Remote = third-party API (privacy + spend implications). */
  readonly remote: boolean;
  /** Env var whose presence opts into this engine. */
  readonly keyEnv?: string;
  /** $/M tokens, official tables 2026. Null = local/free. */
  readonly pricePerM: number | null;
  readonly locked: boolean;
  readonly notes: string;
}

export const ENGINE_DEFS = [
  { name: "voyage", remote: true, keyEnv: "VOYAGE_API_KEY", pricePerM: 0.06, locked: true, notes: "voyage-4 general retrieval" },
  { name: "voyage-code", remote: true, keyEnv: "VOYAGE_API_KEY", pricePerM: 0.12, locked: false, notes: "code-specialized; loses on mixed queries" },
  { name: "voyage-context", remote: true, keyEnv: "VOYAGE_API_KEY", pricePerM: 0.12, locked: false, notes: "contextualized chunks; needs grouped backfill" },
] as const;

export type EngineName = (typeof ENGINE_DEFS)[number]["name"];

/** Resolution order when unpinned: voyage leads; siblings are pin-only. */
export const ENGINE_ORDER: readonly EngineName[] = ["voyage"];

export interface RerankerDef {
  readonly name: string;
  readonly remote: boolean;
  readonly keyEnv?: string;
  /** $/M processed tokens. Null = local/free. */
  readonly pricePerM: number | null;
  /** How it scores a pool: one request per candidate, one shared request, or vendor listwise. */
  readonly mode: "pairwise" | "fanout" | "listwise" | "local";
  readonly locked: boolean;
  readonly notes: string;
}

export const RERANKER_DEFS = [
  { name: "jev", remote: true, keyEnv: "TYPESAFE_API_KEY", pricePerM: 0.042, mode: "pairwise", locked: true, notes: "only reranker measured above hybrid (BEIR 0.445 -> 0.489); judge duty too" },
  { name: "voyage", remote: true, keyEnv: "VOYAGE_API_KEY", pricePerM: 0.05, mode: "listwise", locked: false, notes: "rerank-2.5; 1 req/pool; pin-only until a bake-off against jev; lite/3 via VOYAGE_RERANK_MODEL" },
  { name: "none", remote: false, pricePerM: null, mode: "local", locked: false, notes: "passthrough" },
] as const;

export type RerankerName = (typeof RERANKER_DEFS)[number]["name"];

export const RERANKER_ORDER: readonly RerankerName[] = ["jev", "voyage"];

export interface JudgeDef {
  readonly name: string;
  readonly remote: boolean;
  readonly keyEnv?: string;
  readonly locked: boolean;
  readonly notes: string;
}

export const JUDGE_DEFS = [
  { name: "jev", remote: true, keyEnv: "TYPESAFE_API_KEY", locked: true, notes: "Noul+Score, 12-0 on duels" },
  { name: "heuristic", remote: false, locked: false, notes: "shape confidence only; candidate labels, not verdicts" },
] as const;

export type JudgeName = (typeof JUDGE_DEFS)[number]["name"];

/** The measured production stack, for `gateway models` and doctor checks. */
export function lockedStack(): { engine: string; reranker: string; judge: string } {
  return {
    engine: ENGINE_DEFS.find((e) => e.locked)?.name ?? "voyage",
    reranker: RERANKER_DEFS.find((r) => r.locked)?.name ?? "jev",
    judge: JUDGE_DEFS.find((j) => j.locked)?.name ?? "jev",
  };
}
