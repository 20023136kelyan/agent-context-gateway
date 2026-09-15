# Agent Context Gateway

**Federated semantic search over native agent work histories — not another memory database.**

One agent asks *"What did Codex decide about the collaboration architecture?"* and gets
the relevant turns from Codex's own history, with provenance. No manual memory writes,
no whole-context handoffs, no central source of truth beyond the native histories.

Full concept: [`Agent Context Gateway — Project Specification.md`](./Agent%20Context%20Gateway%20—%20Project%20Specification.md) (§1–80).
Build plan: [`IMPLEMENTATION_PLAN_V2.md`](./IMPLEMENTATION_PLAN_V2.md).

## Status: All Phases Complete (MVP through Phase F)

- [x] MVP — adapters (Claude Code, Codex), Tantivy/SQLite, hybrid search, CLI/HTTP/MCP, acceptance test, watcher, hooks
- [x] Phase 2 — background serve with port-delegation, topology links (`parent|children|siblings|auto`), Cursor adapter, repo-root awareness, bearer auth & read-only federation, artifact polish
- [x] Phase 3 — heuristic decision extraction, bi-temporal reasoning, artifact graph BFS, feedback ranking, mDNS discovery, native SwiftUI menu-bar app
- [x] Phase A — 24-query domain-stratified golden benchmark (`tests/eval/golden.json`), evaluation runner, NDCG/MRR/ALCE metrics, committed baseline
- [x] Phase B — CAsT conversational query rewriting, RRF fusion with similarity calibration, local ONNX neural cross-encoder reranker, multi-hop BFS graph traversal
- [x] Phase C — Derived bi-temporal invalidation markers (non-destructive supersession, point-in-time `asOf` queries), resource-level ACLs with PermCov = 0.0 enforcement
- [x] Phase D — Native Apple Silicon MLX GPU embedding sidecar (BGE-small on Metal, ~150 emb/s, in-process venv), LanceDB integration
- [x] Phase E — Zep Context Lake adapter (`harness: "zep"`), Neural Entailment Decision Judge (`method: "neural-judge"`)
- [x] Phase F — Real-time live active-session search (bypassing index), context subscriptions & push notifications, full agent lineage explorer

## Decisions (Phase 3 & E: Neural Entailment)

Why-questions go to `decide` (`context.decide`, `GET /decide`), not search:

```bash
npx tsx src/cli.ts decide "Why did we reject Monaco?"
```

Two-stage architecture:
1. Heuristic recall scans discussion regions for decision shape (conclusion, rationale, alternatives, question) with speech-act and relevance gating.
2. Neural Entailment Judge (`src/decisions/extract.ts`) evaluates whether candidate conclusions semantically answer the query using local cross-attention (`method: "neural-judge"`).
conversational roles only, whole-word cues, sentence-scoped matching, no
heading anchors, speaker-or-colon form, no attributive adjectives
("the selected session" ≠ "we selected X"). No cues fire → falls back to the
discussion window (today's search), so recall never drops below baseline.

Every claim carries source turn IDs. Confidence blends shape-completeness
with *relevance*: verdicts sharing no query terms collapse to ~0.3
(low-confidence leads) instead of parading as answers. This fixes the worst
failure — confident verdicts on unrelated passages — but partial word overlap
still scores mid-range without understanding. That's precisely the seam for
the future fast Apple Foundation Models precision pass (`method: "apple-fm"`,
`DecisionJudge` in `src/decisions/extract.ts`): verify the verdict *answers*
the query (entailment), not just its shape. The heuristic remains the cheap
recall stage.

## Semantic search (Phase 2, opt-in)

Lexical search matches words, not meaning. For paraphrase-level recall:

```bash
brew install ollama && ollama pull qwen3-embedding:0.6b
npx tsx src/cli.ts sync --embed     # resumable background backfill (~40 turns/s on M4)
```

Hybrid ranking blends Tantivy BM25 (0.45) + cosine similarity (0.25) with the
existing project/recency/entity boosts. Missing vectors degrade gracefully to
lexical. Embeddings live in LanceDB (`~/.context-gateway/vectors-lance`),
disposable like the lexical index. Requires Ollama on `127.0.0.1:11434`;
everything else works offline without it.

Why Ollama and not Apple on-device: spiked `NLEmbedding` (the only Apple
embedding API — Foundation Models is generation-only). It ordered an unrelated
turn above the paraphrase (0.29 > 0.23), failing the quality bar.
`nomic-embed-text`'s registry blob was unreachable; `qwen3-embedding:0.6b`
(1024-dim) orders correctly and runs on the Apple Silicon GPU.

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
Tools: `context.search`, `context.decide`, `context.get_turn`,
`context.get_context`, `context.get_topology`, `context.get_related`,
`context.feedback`, `context.list_sessions`, `context.list_sources`.

## Quickstart
```bash
npm install
npx tsx src/cli.ts sync                                    # index local histories
npx tsx src/cli.ts search "What did Codex decide about collaboration?"
npx tsx src/cli.ts health
```

HTTP (loopback only) and MCP:

```bash
npx tsx src/cli.ts serve --port 3000   # http://127.0.0.1:3000/{health,sources,sessions,search,sync}
npx tsx src/cli.ts mcp                # stdio MCP server: context.search, context.get_turn, …
```

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
   (Unknown/missing sessions exit non-zero with `not_found` and index nothing.
   Adapt the matcher and harness name for other runtimes.)
2. **Watch mode (catch-all)** — `serve --watch [--embed]` re-syncs seconds
   after any `.jsonl` change under the native history dirs.
3. **Full `sync`** — incremental via cursors; `--rebuild` after adapter/ID changes.

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

## Measured performance (2026-09-15, 154 sessions / ~100k turns)

| Operation | Time |
|---|---|
| Cold sync | ~40s (one-time; incremental after) |
| Incremental sync (no changes) | <1s (154 skipped) |
| `index.search` (lexical) | 4–14ms |
| End-to-end `search` (rank + truth packaging) | ~0.7–1.2s (dominated by parsing giant 3–5k-turn sessions) |

## Layout

```text
src/core/          Agent/Session/Turn/Provenance model + stable IDs
src/adapters/      claude.ts, codex.ts, cursor.ts, zep.ts, registry.ts, text.ts, repo.ts
src/embeddings/    provider.ts (unified), mlx.ts (Apple Silicon GPU), ollama.ts
src/indexing/      types.ts, tantivy-index.ts, sqlite-index.ts, vectors.ts (LanceDB), sync.ts, embed-sync.ts
src/search/        query.ts, rank.ts (RRF), rewriter.ts (CAsT), rerank.ts (ONNX), search.ts
src/topology/      store.ts (links, auto routing), lineage.ts (lineage tree explorer)
src/temporal/      bi-temporal.ts (non-destructive invalidations, asOf point-in-time)
src/security/      acl.ts (resource-level ACL rules, PermCov measurement)
src/collaboration/ live.ts (real-time active session search, context subscriptions)
src/artifacts/     graph.ts (co-occurrence & multi-hop BFS graph traversal)
src/feedback/      store.ts (feedback loop + ranking bias)
src/eval/          metrics.ts (NDCG, MRR, ALCE), runner.ts (eval harness)
src/transports/    http.ts (token auth), mcp.ts (16 tools)
src/app.ts         shared singleton factory
src/commands.ts    transport-agnostic logic
src/cli.ts         (auto-delegating CLI)
src/remote.ts      port file, probe, loop-guard federation client
src/remotes.ts     remotes.json (0600) + read-only fan-out
src/watch.ts       fs watcher for serve --watch
launchd/           com.context-gateway.serve.plist
gateway.sh         nvm-resolving entrypoint
ui/                SwiftUI MenuBarExtra native macOS app (GatewayMenuCore + App)
tests/             25 test suites (107 unit/integration tests + 3 Swift XCTest tests)
```

## Known MVP limits

- Local-only, single user (no auth; HTTP binds `127.0.0.1`).
- Lexical search only; no embeddings yet.
- No parent/child/sibling scopes (`scope=parent` → `not_supported_in_mvp`).
- One `TantivyIndex` per index dir per process — share the app instance.
- Summaries are extractive (first lines), never LLM-generated.
- Changing adapter ID schemes or normalization requires `sync --rebuild`
  (incremental sync keys on file mtime/size and can't see ID changes).
