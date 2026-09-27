# Bifröst

**Federated semantic search over native agent work histories — not another memory database.**

One agent asks *"What did Codex decide about the collaboration architecture?"* and gets
the relevant turns from Codex's own history, with provenance. No manual memory writes,
no whole-context handoffs, no central source of truth beyond the native histories.

Full concept: [`Bifröst — Project Specification.md`](./Bifr%C3%B6st%20—%20Project%20Specification.md) (§1–80).
Build plan: [`IMPLEMENTATION_PLAN_V2.md`](./IMPLEMENTATION_PLAN_V2.md).
Review fixes: [`REVIEW_FIX_PLAN.md`](./REVIEW_FIX_PLAN.md).

## Current approach: the locked stack (0.2.0)

The retrieval pipeline has moved from local models to a small, measured stack
of remote APIs. Local fallbacks (MLX and Ollama embeddings, the ONNX
cross-encoder, the local entailment judge) were **deleted, not deprecated**.

| Stage | Component | Opt-in key | Notes |
|---|---|---|---|
| Embeddings | Voyage `voyage-4` (1024-dim) | `VOYAGE_API_KEY` | `voyage-code` / `voyage-context` resolvable only when pinned |
| Reranking | Jev (TypeSafe, pairwise) → Voyage `rerank-2.5` | `TYPESAFE_API_KEY` / `VOYAGE_API_KEY` | on by default only when Jev is the resolved reranker |
| Decision judge | Jev (Noul + Score) | `TYPESAFE_API_KEY` | without it, verdicts stay labelled `heuristic` |
| Lexical | Tantivy BM25 | — | always on; the whole system runs lexical-only with no keys |

`src/components.ts` is the single source of truth for engines, rerankers and
judges (types, resolution order, allow-lists, cost basis). `bifrost models`
prints the locked stack next to what this machine actually resolves.

**Privacy trade-off.** Setting either key sends data off-machine: Voyage sees
indexed turn text at backfill time, and Jev sees query text plus candidate
excerpts *on every search*. This is a deliberate departure from spec §73
Principle 5 (local-first). No key means nothing leaves the machine.

## Status: All Phases Complete (MVP through Phase F) + review fixes

- [x] MVP — adapters (Claude Code, Codex), Tantivy/SQLite, hybrid search, CLI/HTTP/MCP, acceptance test, watcher, hooks
- [x] Phase 2 — background serve with port-delegation, topology links (`parent|children|siblings|auto`), Cursor adapter, repo-root awareness, bearer auth & read-only federation, artifact polish
- [x] Phase 3 — heuristic decision extraction, bi-temporal reasoning, artifact graph BFS, feedback ranking, mDNS discovery, native SwiftUI menu-bar app
- [x] Phase A — 24-query domain-stratified golden benchmark (`tests/eval/golden.json`), evaluation runner, NDCG/MRR/ALCE metrics, committed baseline
- [x] Phase B — CAsT conversational query rewriting, RRF fusion with similarity calibration, local ONNX neural cross-encoder reranker, multi-hop BFS graph traversal
- [x] Phase C — Derived bi-temporal invalidation markers (non-destructive supersession, point-in-time `asOf` queries), resource-level ACLs
- [x] Phase D — Native Apple Silicon MLX GPU embedding sidecar (BGE-small on Metal, in-process venv), LanceDB integration
- [x] Phase E — Zep Context Lake adapter (`harness: "zep"`), Neural Entailment Decision Judge (`method: "neural-judge"`)
- [x] Phase F — Real-time live active-session search (bypassing index), context subscriptions & webhook delivery, full agent lineage explorer
- [x] Review fixes (2026-09-16) — correctness, security and performance pass over the whole codebase; see [`REVIEW_FIX_PLAN.md`](./REVIEW_FIX_PLAN.md)
- [x] 0.2.0 (2026-09-23) — locked Voyage/Jev stack replaces the local models, component registry, product surface (`init`/`doctor`/`models`/`stats`/`telemetry`), OpenCode adapter, per-locale decision cues, BEIR + sweep eval harness

Phase D (MLX/LanceDB) and the local reranker/judge from Phases B and E have
been superseded by the locked stack above; LanceDB remains as one of two
vector backends.

## Quickstart

```bash
npm install
cp .env.example .env          # optional: VOYAGE_API_KEY, TYPESAFE_API_KEY
npx tsx src/cli.ts init       # detects histories, sets keys, syncs, backfills, installs hooks, verifies
npx tsx src/cli.ts search "What did Codex decide about collaboration?"
npx tsx src/cli.ts health
npx tsx src/cli.ts doctor     # histories, keys, index, vectors, models in one report
npx tsx src/cli.ts models     # swappable engines/rerankers/judges, availability, resolved defaults
npx tsx src/cli.ts stats      # shape-only usage aggregates (never content)
```

HTTP (loopback) and MCP:

```bash
npx tsx src/cli.ts serve --port 3000   # http://127.0.0.1:3000/{health,sources,sessions,search,sync}
npx tsx src/cli.ts mcp                # stdio MCP server: context.search, context.get_turn, …
```

## Network access and auth

The API binds `127.0.0.1` by default and answers unauthenticated loopback callers,
which is the local-first case. Two things protect that surface:

- **Host allowlist.** Requests without a valid token must carry a loopback `Host`
  (extend with `BIFROST_ALLOWED_HOSTS=host1,host2`). This blocks DNS rebinding: a
  hostile page that resolves its own domain to 127.0.0.1 still sends its own Host.
  `/health` answers `{ok:true}` to anything, for liveness probes.
- **Origin check.** Browser writes (POST/DELETE) whose `Origin` isn't an allowed
  host are refused, so a random web page can't trigger `/sync?rebuild=true` or
  poison `/feedback`. CLI, curl and the menu-bar app send no `Origin`.

Serving other machines is opt-in and needs a token:

```bash
BIFROST_TOKEN=$(openssl rand -hex 32) npx tsx src/cli.ts serve --host 0.0.0.0 --announce
```

`--host` refuses any non-loopback address without `BIFROST_TOKEN`; token-bearing
requests are accepted from any Host. `--announce` (mDNS `_bifrost._tcp`)
requires a non-loopback bind, since a loopback-only instance is unreachable anyway.
Remotes added with `remotes-add --token` send their token on every federated query.

## Decisions

Why-questions go to `decide` (`context.decide`, `GET /decide`), not search:

```bash
npx tsx src/cli.ts decide "Why did we reject Monaco?"
```

Two-stage architecture:
1. Heuristic recall scans discussion regions for decision shape (conclusion, rationale, alternatives, question) with speech-act and relevance gating: conversational roles only, whole-word cues, sentence-scoped matching, no heading anchors, speaker-or-colon form, no attributive adjectives ("the selected session" ≠ "we selected X"). Only sentences that *end* in "?" count as questions, so a URL or `?.` in a turn no longer hides a verdict.
2. The Jev decision judge (`src/judgments/judge-jev.ts`, selected in `src/decisions/select.ts`) returns a typed, calibrated judgment of whether a candidate conclusion answers the query. Measured on the fixture corpus it takes decision citations from Hit@1 0.381 to 0.952. Without `TYPESAFE_API_KEY` (or with `BIFROST_JUDGE=heuristic`) verdicts keep their `heuristic` label instead of claiming a judgement that never happened.

Decision cues are per-locale packs (`src/decisions/locales/`), selected with
`BIFROST_LOCALE` (default `en`).

Every claim carries source turn IDs. Confidence blends shape-completeness with
*relevance*: verdicts sharing no query terms collapse to ~0.3 (low-confidence
leads) instead of parading as answers.

## Semantic search

Lexical search matches words, not meaning. Embeddings add paraphrase-level recall:

- **Engine: Voyage `voyage-4`** (1024-dim), enabled by `VOYAGE_API_KEY`.
  `BIFROST_EMBED_ENGINE` pins `voyage`, `voyage-code` or `voyage-context`; a
  pinned engine never falls back, so one corpus can't scatter across tables.
  The provider asserts the returned width matches `VOYAGE_DIM` and throws if not.
- **Storage is keyed by engine, not width.** Two engines can emit the same
  dimension, and blending their spaces would return plausible garbage.
- **Vector backend:** LanceDB, or sqlite-vec when the LanceDB native addon is
  absent (always the case on Intel macOS). Pin with `BIFROST_VECTOR_BACKEND`.
- **Query-vector cache:** query embeddings are cached per (engine, text); the
  Voyage round trip is the largest fixed cost on the search path.

```bash
npx tsx src/cli.ts backfill              # resumable; one engine per run
npx tsx src/cli.ts search "…" --json     # add ?semantic=false (HTTP) or semantic:false (MCP) for lexical only
```

Hybrid ranking fuses Tantivy BM25 and cosine similarity with RRF, plus
project/repo/recency/entity/feedback boosts. Missing vectors or a Voyage outage
degrade to lexical (counted by `embedMeter`, so evals can flag it).

`BIFROST_SIM_FLOOR`, `BIFROST_SIM_SPAN` and `BIFROST_MIN_VECTOR_SIM` are
**engine-calibrated** (swept for voyage-4). Re-sweep before trusting another
engine: a wrong floor silently zeroes semantic hits.

### Reranking

`src/search/reranker.ts` resolves the reranker in order **jev → voyage → none**;
`BIFROST_RERANKER` pins one and never falls back.

- **Jev (pairwise)** reranks by default on every transport. Fixture corpus:
  hybrid NDCG@5 0.699 → 0.968; BEIR nfcorpus: 0.445 → 0.489. Costs ~450–620 ms
  per search and sends query + excerpts off-machine.
- **Voyage `rerank-2.5`** scores the whole pool in one request
  (`VOYAGE_RERANK_MODEL` for lite variants). It is off unless requested, pending
  the reranker bake-off.
- Opt out per request with `?rerank=false`, `--no-rerank` or `rerank: false`,
  or system-wide with `BIFROST_RERANKER=none`. The pool size is `BIFROST_RERANK_POOL` (default 30).

## Staying fresh (new chats)

Three layers, fastest first:

1. **Session-end hook (precise)** — sync exactly the session that just ended:
   ```bash
   npx tsx src/cli.ts sync-session claude-code "$SESSION_ID" --embed
   ```
   Claude Code (`~/.claude/settings.json`) — hooks receive JSON on stdin,
   so extract `session_id` with `jq`:
   ```json
   { "hooks": { "SessionEnd": [{
     "hooks": [{ "type": "command",
       "command": "SID=$(jq -r .session_id); node --import tsx \"/Users/admin/dev/bifrost/src/cli.ts\" sync-session claude-code \"$SID\"" }]
   }] } }
   ```
2. **Watch mode (catch-all)** — `serve --watch [--embed]` re-syncs seconds after any
   `.jsonl` change, and embeds only the sessions that sync touched.
3. **Full `sync`** — incremental via cursors; `--rebuild` after adapter/ID changes.

Git commits can feed the artifact graph too:

```bash
npx tsx src/cli.ts git-hooks install --repo /path/to/repo
```

The hook posts url-encoded fields (multi-line messages, quotes and backslashes
survive), honours `BIFROST_PORT`/`BIFROST_TOKEN`, and preserves any existing
post-commit/post-merge hook as `<name>.pre-bifrost`, which it runs first.

## Subscriptions

Register interest in a query and get matching *new* turns pushed:

```bash
npx tsx src/cli.ts subscribe "narwhal migration" --webhook http://127.0.0.1:9000/notify
```

Every sync (watcher, `POST /sync`, `sync-session`, git events) checks turns that are
new to the index against active subscriptions — a rebuild re-indexes history and
deliberately notifies nobody. Matching drops stop-words like search does. Webhooks
must be http(s) and get a 5s timeout; the last 20 notifications per subscription are
kept for `GET /subscriptions` and the `context.list_subscriptions` MCP tool, which is
how an MCP agent polls without a webhook.

## Calling the MCP server

Stdio transport — works alongside the background `serve` (readers share the
index; only concurrent *writes* contend):

```bash
# MCP Inspector (zero config):
npx @modelcontextprotocol/inspector node --import tsx src/cli.ts mcp
```

opencode (`~/.config/opencode/opencode.json`):

```json
{ "mcp": { "bifrost": {
  "type": "local",
  "command": ["node", "--import", "tsx", "/Users/admin/dev/bifrost/src/cli.ts", "mcp"]
} } }
```

Claude Code: `claude mcp add bifrost -- node --import tsx /Users/admin/dev/bifrost/src/cli.ts mcp`.
Tools: `context.search`, `context.decide`, `context.get_session`, `context.get_turn`,
`context.get_context`, `context.get_topology`, `context.explore_lineage`,
`context.get_related`, `context.traverse_artifacts`, `context.get_invalidations`,
`context.get_acl_rules`, `context.search_live`, `context.subscribe`,
`context.list_subscriptions`, `context.feedback`, `context.list_sessions`,
`context.list_sources`.

## Native menu-bar app (Phase 3)

```bash
./ui/build-app.sh && open BifrostMenu.app
```

SwiftUI `MenuBarExtra` (branch icon, macOS 13+) against the loopback API:
Search and Why tabs, harness picker, inline evidence with provenance,
Helpful/Not-helpful buttons wired to `POST /feedback`, Settings shows index
health. Port configurable (default 3000). `ui/Tests` decode live `/health`,
`/search` and `/decide` responses — the contract between Bifröst JSON and
Swift models is tested, not assumed.

## Evaluation

```bash
npm run eval -- --mode hybrid --save tests/eval/baseline.json
npm run eval -- --fixture             # synthetic 72-session fixture corpus
npm run sweep -- sweeps/example.json  # grid of corpus × arm × env cells → SQLite
```

Modes are distinct pipelines: `lexical` (no vectors), `hybrid` (vectors + RRF;
`rrf` is an alias) and rerank arms (hybrid + a named reranker). Golden sets
live in `tests/eval/` (live histories, fixture, entities, trajectories,
SWE-Gym) and report NDCG@5, MRR@5, P@1, P@5, latency and ALCE citation metrics.

Numbers from the synthetic fixture are re-checked against corpora nobody here
wrote: `src/eval/beir.ts` loads any BEIR dataset (nfcorpus so far). Sweep cells
run under an isolated home with every unused harness dead-ended, so a scoring
run can't leak golden queries into the live store.

`npx tsx scripts/bench.ts [--sync]` times the hot paths against the real local
histories (read-only).

## Architecture

```text
Claude Code ─┐
Codex ───────┤                  ┌─► Tantivy BM25 (disposable) ─┐
Cursor ──────┼─► adapters ──────┤                              ├─► RRF + boosts ─► rerank ─► CLI / HTTP / MCP
OpenCode ────┤  (native truth,  └─► Voyage vectors ────────────┘   (Jev → Voyage)       │
Zep / git ───┘   never mutated)     (LanceDB | sqlite-vec)                               ▼
                                                                   decide: heuristic recall ─► Jev judge
```

Principles (§73): native history is truth; provenance always; least context
necessary (summary + ±3-turn evidence + budgets); disposable index
(`sync --rebuild` reproduces it); no hallucinated context (extractive summaries only).
Local-first is now the no-key default rather than an absolute: configuring
Voyage or Jev is an explicit opt-in to sending data off-machine.

## Measured performance (2026-09-16, 159 sessions / ~107k turns / 100k docs, M4)

Historical: measured before the move to the locked stack, so the rerank and
judge rows describe the since-deleted local models. Before/after the review-fix pass (`scripts/bench.ts`, medians):

| Operation | Before | After |
|---|---:|---:|
| `index.stats()` (called on every search) | 37.5 ms | 0.2 ms |
| Codex `listTurns` ×5, caches warm | 21 ms | 0.1 ms |
| 24 golden queries, lexical | 3957 ms | 2692 ms |
| 24 golden queries, hybrid | 1972 ms | 822 ms |
| `extractDecisions` over a 2529-turn session | 308 ms | 44 ms |
| `decideOnce` (search + judge) | 1359 ms | 1294 ms |
| Rerank 15 candidates (cross-encoder) | 1374 ms | 1355 ms |
| Cold full sync | 52.7 s | 12.8 s |
| Incremental sync, no changes | 46.8 ms | 14.3 ms |

Batching the cross-encoder was tried and reverted: padding every pair to the
longest made it slower (2.7 s vs 1.7 s for 15 pairs) on CPU ONNX.

## Layout

```text
src/core/          Agent/Session/Turn/Provenance model + stable IDs, LruCache
src/adapters/      claude, codex, cursor, opencode, zep, git, trajectories, text, repo
src/components.ts  component registry: engines, rerankers, judges, locked stack, cost basis
src/embeddings/    provider.ts (engine registry + query cache), voyage.ts, voyage-context.ts
src/indexing/      tantivy-index, sqlite-index, vectors (LanceDB), vectors-sqlite, vector-backend, sync, embed-sync
src/search/        query, rank (RRF), rewriter (CAsT), reranker (selection), rerank-voyage, route (experimental router), search
src/judgments/     jev.ts (TypeSafe client), rerank-jev.ts, judge-jev.ts
src/decisions/     cues.ts + locales/, extract.ts (heuristic recall), select.ts (judge selection)
src/topology/      store.ts (links, auto routing), lineage.ts (lineage tree explorer)
src/temporal/      bi-temporal.ts (non-destructive invalidations, asOf point-in-time)
src/security/      acl.ts (resource-level ACL rules, PermCov measurement)
src/collaboration/ live.ts (real-time active session search, subscriptions + delivery)
src/artifacts/     graph.ts (co-occurrence & multi-hop BFS graph traversal)
src/feedback/      store.ts (feedback loop + ranking bias)
src/observability/ usage.ts (shape-only local usage log), report.ts (opt-in aggregate telemetry)
src/eval/          metrics.ts (NDCG, MRR, ALCE), runner.ts (eval arms), beir.ts (BEIR datasets)
src/transports/    http.ts (token auth, host/origin checks), mcp.ts (17 tools)
src/app.ts         shared singleton factory + write locks
src/commands.ts    transport-agnostic logic
src/settings.ts    typed settings: CLI flag > env > settings.json > default
src/setup.ts       init/doctor primitives (idempotent, backed-up edits)
src/cli.ts         (auto-delegating CLI)
src/remote.ts      port file, probe, loop-guard federation client
src/remotes.ts     remotes.json (0600) + read-only fan-out
src/watch.ts       fs watcher for serve --watch
scripts/           run-eval.ts, sweep.ts, sweep-cell.ts, bench.ts, score-contexts.mjs
sweeps/            sweep manifests
experiments/       training experiments (contrastive/DAPT), deferred paid-hosting notes
launchd/           com.bifrost.serve.plist
bifrost.sh         nvm-resolving entrypoint
ui/                SwiftUI MenuBarExtra native macOS app (BifrostMenuCore + App)
tests/             37 suites (~230 tests) + Swift XCTest decoding tests
```

## Known limits

- Single user. Loopback by default; serving the network is opt-in and requires `BIFROST_TOKEN`.
- Semantic search, default reranking and judged decisions need third-party keys (Voyage, TypeSafe). Without them Bifröst is lexical-only with heuristic decision labels.
- Jev reranking adds ~0.5 s per search; the Voyage reranker's place in the order is provisional until the reranker bake-off.
- Summaries are extractive (first lines), never LLM-generated.
- Changing adapter ID schemes or normalization requires `sync --rebuild` (incremental sync keys on file mtime/size and can't see ID changes).
- One `TantivyIndex` writer per index dir per process — the CLI delegates writes to a live `serve`; readers are unaffected.
- The Cursor adapter follows the documented 2026 format but has never been verified against a real Cursor history.
- The Git adapter lists HEAD's last 50 commits for every branch session, so branch sessions other than the checked-out one repeat HEAD's log.
- `deriveFromTurns` (automatic supersession detection) is library-only: nothing runs it during sync, so invalidations come from `POST /temporal/invalidate`.
- If Voyage or Jev is unreachable, search falls back to lexical and RRF order (`neural: false` on results) rather than failing.
- Parsed turns are cached per adapter (256 sessions / 200M chars, ~222 MB for the measured corpus).
- Zep sessions served by the REST API are re-indexed at most every 5 minutes (the API exposes no change stamp).
