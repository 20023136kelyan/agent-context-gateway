# Agent Context Gateway

**Federated semantic search over native agent work histories — not another memory database.**

One agent asks *"What did Codex decide about the collaboration architecture?"* and gets
the relevant turns from Codex's own history, with provenance. No manual memory writes,
no whole-context handoffs, no central source of truth beyond the native histories.

Full concept: [`Agent Context Gateway — Project Specification.md`](./Agent%20Context%20Gateway%20—%20Project%20Specification.md) (§1–80).
Build plan: [`IMPLEMENTATION_PLAN_V2.md`](./IMPLEMENTATION_PLAN_V2.md).
Review fixes: [`REVIEW_FIX_PLAN.md`](./REVIEW_FIX_PLAN.md).

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

## Quickstart

```bash
npm install
npx tsx src/cli.ts sync                                    # index local histories
npx tsx src/cli.ts search "What did Codex decide about collaboration?"
npx tsx src/cli.ts health
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
  (extend with `GATEWAY_ALLOWED_HOSTS=host1,host2`). This blocks DNS rebinding: a
  hostile page that resolves its own domain to 127.0.0.1 still sends its own Host.
  `/health` answers `{ok:true}` to anything, for liveness probes.
- **Origin check.** Browser writes (POST/DELETE) whose `Origin` isn't an allowed
  host are refused, so a random web page can't trigger `/sync?rebuild=true` or
  poison `/feedback`. CLI, curl and the menu-bar app send no `Origin`.

Serving other machines is opt-in and needs a token:

```bash
GATEWAY_TOKEN=$(openssl rand -hex 32) npx tsx src/cli.ts serve --host 0.0.0.0 --announce
```

`--host` refuses any non-loopback address without `GATEWAY_TOKEN`; token-bearing
requests are accepted from any Host. `--announce` (mDNS `_context-gateway._tcp`)
requires a non-loopback bind, since a loopback-only gateway is unreachable anyway.
Remotes added with `remotes-add --token` send their token on every federated query.

## Decisions

Why-questions go to `decide` (`context.decide`, `GET /decide`), not search:

```bash
npx tsx src/cli.ts decide "Why did we reject Monaco?"
```

Two-stage architecture:
1. Heuristic recall scans discussion regions for decision shape (conclusion, rationale, alternatives, question) with speech-act and relevance gating: conversational roles only, whole-word cues, sentence-scoped matching, no heading anchors, speaker-or-colon form, no attributive adjectives ("the selected session" ≠ "we selected X"). Only sentences that *end* in "?" count as questions, so a URL or `?.` in a turn no longer hides a verdict.
2. The Neural Entailment Judge (`src/decisions/extract.ts`) scores whether a candidate conclusion answers the query, using local cross-attention (`method: "neural-judge"`). If that model can't run, the verdict keeps its `heuristic` label instead of claiming a judgement that never happened.

Every claim carries source turn IDs. Confidence blends shape-completeness with
*relevance*: verdicts sharing no query terms collapse to ~0.3 (low-confidence
leads) instead of parading as answers.

## Semantic search

Lexical search matches words, not meaning. Embeddings add paraphrase-level recall:

- **Default engine: MLX** (BGE-small, 384-dim) on the Apple Silicon GPU, run by an
  in-process Python worker from `~/.context-gateway/mlx-venv`. The worker script is
  resolved next to its module, so MCP servers and hooks started in other
  directories use the same engine (and therefore the same vector table).
- **Fallback: Ollama** (`qwen3-embedding:0.6b`, 1024-dim) when the venv is absent.
  A worker that dies is reported immediately and skipped for 60s rather than
  stalling every call, and each request has a timeout.

Each engine writes its own table (`turns_384`, `turns_1024`), and backfill pins one
engine per run so a mid-run fallback can't scatter a session across tables.

```bash
npx tsx src/cli.ts backfill              # resumable; compacts and indexes ids when done
npx tsx src/cli.ts search "…" --json     # add ?semantic=false (HTTP) or semantic:false (MCP) for lexical only
```

Hybrid ranking fuses Tantivy BM25 and cosine similarity with RRF, plus
project/repo/recency/entity/feedback boosts. Missing vectors degrade to lexical.
Vectors live in LanceDB (`~/.context-gateway/vectors-lance`), disposable like the
lexical index.

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
       "command": "SID=$(jq -r .session_id); node --import tsx \"/Users/admin/dev/Agent Context Gateway/src/cli.ts\" sync-session claude-code \"$SID\"" }]
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
survive), honours `GATEWAY_PORT`/`GATEWAY_TOKEN`, and preserves any existing
post-commit/post-merge hook as `<name>.pre-gateway`, which it runs first.

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
{ "mcp": { "context-gateway": {
  "type": "local",
  "command": ["node", "--import", "tsx", "/Users/admin/dev/Agent Context Gateway/src/cli.ts", "mcp"]
} } }
```

Claude Code: `claude mcp add context-gateway -- node --import tsx /Users/admin/dev/Agent\ Context\ Gateway/src/cli.ts mcp`.
Tools: `context.search`, `context.decide`, `context.get_session`, `context.get_turn`,
`context.get_context`, `context.get_topology`, `context.explore_lineage`,
`context.get_related`, `context.traverse_artifacts`, `context.get_invalidations`,
`context.get_acl_rules`, `context.search_live`, `context.subscribe`,
`context.list_subscriptions`, `context.feedback`, `context.list_sessions`,
`context.list_sources`.

## Native menu-bar app (Phase 3)

```bash
./ui/build-app.sh && open ContextGatewayMenu.app
```

SwiftUI `MenuBarExtra` (branch icon, macOS 13+) against the loopback API:
Search and Why tabs, harness picker, inline evidence with provenance,
Helpful/Not-helpful buttons wired to `POST /feedback`, Settings shows index
health. Port configurable (default 3000). `ui/Tests` decode live `/health`,
`/search` and `/decide` responses — the contract between gateway JSON and
Swift models is tested, not assumed.

## Evaluation

```bash
npm run eval -- --mode hybrid --save tests/eval/baseline.json
```

Modes are distinct pipelines: `lexical` (no vectors), `hybrid` (vectors + RRF;
`rrf` is an alias) and `rerank` (hybrid + cross-encoder). 24 domain-stratified
golden queries report NDCG@5, MRR@5, P@1, P@5, latency and ALCE citation metrics.

`npx tsx scripts/bench.ts [--sync]` times the hot paths against the real local
histories (read-only).

## Architecture

```text
Claude history ──► ClaudeAdapter ──┐
                                   ├──► Tantivy index (disposable) ──► SearchService ──► CLI / HTTP / MCP
Codex history ───► CodexAdapter ───┘         ▲                              │
        native truth (never mutated)         │                              ▼
                                             │                     adapters (truth) for
                                             │                     expansion + packaging
```

Principles (§73): native history is truth; provenance always; least context
necessary (summary + ±3-turn evidence + budgets); local-first; disposable index
(`sync --rebuild` reproduces it); no hallucinated context (extractive summaries only).

## Measured performance (2026-09-16, 159 sessions / ~107k turns / 100k docs, M4)

Before/after the review-fix pass (`scripts/bench.ts`, medians):

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
src/adapters/      claude.ts, codex.ts, cursor.ts, zep.ts, git.ts, text.ts, repo.ts
src/embeddings/    provider.ts (engine + dim), mlx.ts (Apple Silicon GPU), ollama.ts
src/indexing/      types.ts, tantivy-index.ts, sqlite-index.ts, vectors.ts (LanceDB), sync.ts, embed-sync.ts
src/search/        query.ts, rank.ts (RRF), rewriter.ts (CAsT), rerank.ts (ONNX), search.ts
src/topology/      store.ts (links, auto routing), lineage.ts (lineage tree explorer)
src/temporal/      bi-temporal.ts (non-destructive invalidations, asOf point-in-time)
src/security/      acl.ts (resource-level ACL rules, PermCov measurement)
src/collaboration/ live.ts (real-time active session search, subscriptions + delivery)
src/artifacts/     graph.ts (co-occurrence & multi-hop BFS graph traversal)
src/feedback/      store.ts (feedback loop + ranking bias)
src/eval/          metrics.ts (NDCG, MRR, ALCE), runner.ts (eval harness, modes)
src/transports/    http.ts (token auth, host/origin checks), mcp.ts (17 tools)
src/app.ts         shared singleton factory + write locks
src/commands.ts    transport-agnostic logic
src/cli.ts         (auto-delegating CLI)
src/remote.ts      port file, probe, loop-guard federation client
src/remotes.ts     remotes.json (0600) + read-only fan-out
src/watch.ts       fs watcher for serve --watch
scripts/           run-eval.ts, bench.ts
launchd/           com.context-gateway.serve.plist
gateway.sh         nvm-resolving entrypoint
ui/                SwiftUI MenuBarExtra native macOS app (GatewayMenuCore + App)
tests/             27 suites (154 tests) + 3 Swift XCTest tests
```

## Known limits

- Single user. Loopback by default; serving the network is opt-in and requires `GATEWAY_TOKEN`.
- Summaries are extractive (first lines), never LLM-generated.
- Changing adapter ID schemes or normalization requires `sync --rebuild` (incremental sync keys on file mtime/size and can't see ID changes).
- One `TantivyIndex` writer per index dir per process — the CLI delegates writes to a live `serve`; readers are unaffected.
- The Cursor adapter follows the documented 2026 format but has never been verified against a real Cursor history.
- The Git adapter lists HEAD's last 50 commits for every branch session, so branch sessions other than the checked-out one repeat HEAD's log.
- `deriveFromTurns` (automatic supersession detection) is library-only: nothing runs it during sync, so invalidations come from `POST /temporal/invalidate`.
- The cross-encoder reranker downloads its model from Hugging Face on first use; without network the search falls back to RRF ranking.
- Parsed turns are cached per adapter (256 sessions / 200M chars, ~222 MB for the measured corpus).
- Zep sessions served by the REST API are re-indexed at most every 5 minutes (the API exposes no change stamp).
