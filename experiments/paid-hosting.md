# NOTE (deferred): paid hosted tier

Decision 2026-09-21: be good first, monetize later. When revisited:

- Server-side vendor keys (env, never client); per-principal metering is the
  load-bearing piece (today's meters are process-global — fine for sweeps,
  useless for billing).
- Measured cost basis (real corpus, 2026-09-21): lexical/hybrid ~$0.0000003,
  local rerank $0, jev-pairwise ~$0.00058 per search. At these numbers even
  $0.01/search is 16x markup; flat plans are unlosable.
- Jev public pricing: $0.042/M input, output free (~$0.0004/decision bench).
  Voyage-4: $0.06/M (200M free). voyage-code-4: $0.12/M.
- Needs: real user identity (per-user tokens, not shared GATEWAY_TOKEN),
  persisted per-principal counters, quota enforcement before search runs.

Do NOT build tiers until retrieval quality is where it needs to be.
