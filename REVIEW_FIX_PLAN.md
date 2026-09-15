# Review Fix Plan

Source: xhigh code review of the whole codebase (2026-09-16).
Baseline commit: `c3ef061` · `tsc --noEmit`: clean · tests: 110/111 pass. The one failure (`tests/discovery.test.ts`, mDNS announce/discover) is pre-existing and most likely environmental (multicast unavailable in the sandbox); it is not caused by the fixes below.

## Ground rules

- Work on branch `review-fixes`; one commit per item (or a tight group), message names the item ID.
- Every correctness fix lands with a regression test that fails on the baseline and passes after.
- After each commit: `npx tsc --noEmit` and `npm test` stay green.
- No drive-by refactors inside a fix commit. Cleanup has its own phase.
- Performance items are measured before/after (eval latency p50/p95, plus targeted timings noted per item).

## Phase 1: Data correctness (index missing or holding wrong data)

| ID | Problem | Fix | Test | Files |
|---|---|---|---|---|
| 1.1 | Sync skips every session after the first one sharing a source file (Cursor `state.vscdb`, Zep `threads.json`, Git `.git`); `syncSession` stamps the shared cursor too. Zep API sessions (URL `sourcePath`) never index. | Group sessions by `sourcePath`; decide "changed" once per source, index all its sessions, then stamp the cursor. `syncSession` stamps only when the source holds a single session. Non-file sources (URLs) skip `stat` and re-index each pass. | Zep fixture with 3 threads → 3 sessions indexed; second sync skips all 3; touch file → all 3 re-index. | `indexing/sync.ts`, `commands.ts` |
| 1.2 | `listTurns` failure is swallowed, zero turns indexed, cursor stamped: session never retried until the file changes. | On failure: don't stamp the cursor, count it in a new `sessionsFailed` result field. | Adapter stub that throws once → cursor unset → next sync indexes it. | `indexing/sync.ts` |
| 1.3 | Vector backfill dedup checks the first-opened table (legacy 1024-dim `turns`, 12,211 rows) instead of the active model's table (`turns_384`, 3,800 rows); per-batch MLX→Ollama fallback scatters batches across tables. | Provider exposes the active engine + dim; `embedSessionTurns` passes the dim to `existing()`; `existing()` without a dim becomes an error. Pin the engine once per backfill run (no silent per-batch switch). | Two tables present → `existing(ids, 384)` ignores the 1024 table; backfill fills the 384 table. | `indexing/vectors.ts`, `indexing/embed-sync.ts`, `embeddings/provider.ts` |
| 1.4 | File-ref regex truncates extensions (`package.json`→`package.js`, `App.tsx`→`App.ts`); SHA regex treats UUID segments and hex words ("defaced") as commits. | Longest-first extension alternation + `(?![A-Za-z0-9])`; SHAs require a digit and a letter and must not be part of a UUID. | Table of cases incl. the ones verified in the review. | `adapters/text.ts` |
| 1.5 | Git hook builds JSON by shell interpolation (multi-line or quoted messages → invalid JSON, silently dropped); install overwrites existing hooks; hardcoded port, no token. | Send fields with `curl --data-urlencode` (server accepts form or JSON); preserve an existing hook as `<name>.pre-gateway` and chain it; sentinel line makes reinstall idempotent; port/token from env at run time. | Install into temp repo with a pre-existing hook → both run; commit with a multi-line quoted message reaches `/hooks/git` intact. | `git/hooks.ts`, `transports/http.ts` |

## Phase 2: Security and state wiring

| ID | Problem | Fix | Test | Files |
|---|---|---|---|---|
| 2.1 | `sync --rebuild` builds a fresh `SearchService` and re-attaches only vectors: ACL, topology, feedback, temporal silently disabled until restart. | One `wireSearch(app)` used by `createApp` and rebuild (or `SearchService.setIndex`), so attachments can't be forgotten. | Rebuild, then search as an ACL-restricted principal → still filtered. | `app.ts`, `commands.ts`, `search/search.ts` |
| 2.2 | Watcher sync, `POST /sync`, `syncSession`, and git events can run concurrently over one writer and cursor store; rebuild can close the index under a running sync. | App-level async mutex around all index writes. | Rebuild concurrent with a sync → both complete, doc count consistent. | `app.ts`, `watch.ts`, `commands.ts`, `git/hooks.ts` |
| 2.3 | Loopback HTTP API has no Host/Origin checks and no token by default: CSRF (`POST /sync?rebuild=true`, `/feedback`) and DNS-rebinding reads of `/search`. | `onRequest`: allow only `127.0.0.1:<port>` / `localhost:<port>` Hosts (extendable via `GATEWAY_ALLOWED_HOSTS`); reject non-GET requests carrying a non-loopback `Origin`. Swift app and CLI unaffected. | `inject` with `Host: evil.test` → 403; POST with `Origin: https://evil.test` → 403; normal CLI/Swift requests → 200. | `transports/http.ts` |

## Phase 3: Search correctness

| ID | Problem | Fix | Test | Files |
|---|---|---|---|---|
| 3.1 | MLX worker script resolved from `process.cwd()`: MCP server and hooks (other cwds) silently use Ollama and query the legacy table. | Resolve from `import.meta.url`. | `isAvailable()` true after `chdir` to a temp dir. | `embeddings/mlx.ts` |
| 3.2 | MLX worker startup failure stalls every embed call 8s; no per-request timeout (a wedged worker hangs search). | Reject the ready promise on exit/spawn error; cool-down flag skips MLX for 60s after a failure; per-request timeout kills and resets the worker. | Fake venv python that exits 1 → `embedTexts` rejects in <1s; second call within cool-down doesn't respawn. | `embeddings/mlx.ts` |
| 3.3 | Rerank rescored only the top 15 and re-sorted them against raw tail scores (different scales): the tail can outrank reranked results. | Reranked slice keeps its order; tail is placed after it (scores mapped below the reranked minimum). | Stub reranker scoring everything low → top results still come from the reranked slice. | `search/search.ts` |
| 3.4 | Topology rewrite uses the harness *filter* as the caller's harness (defaults to `claude-code`); resolved targets always report scope `parent`. | Resolve the caller's harness from the session map before rewriting; rewriter returns the matched relation. | Codex caller with a parent link, no harness filter → "my parent" resolves; child reference reports `children`. | `search/search.ts`, `search/rewriter.ts` |
| 3.5 | Eval `--mode lexical` still attaches vectors via `searchOnce`; all modes run the same pipeline, so the committed baseline can't compare them. | `SearchOptions.semantic` (default true) honored by `SearchService` and `searchOnce`; runner maps modes: `lexical` (no vectors), `hybrid` (vectors + RRF), `rerank` (hybrid + cross-encoder; `rrf` kept as an alias of `hybrid`). Regenerate `tests/eval/baseline.json`. | Lexical mode → vector store never queried (spy). | `search/search.ts`, `commands.ts`, `eval/runner.ts`, `scripts/run-eval.ts` |
| 3.6 | Subscriptions are stored but never evaluated or delivered (`notifyTurns` has no caller). | **Decision D2.** If implement: sync returns newly indexed turns → `notifyTurns` → webhook POST (http/https only, timeout, fire-and-forget) + last N notifications kept per subscription. If remove: drop the MCP tool, HTTP routes, and README claim. | Implement: new matching turn → webhook receives payload. | `collaboration/live.ts`, `indexing/sync.ts`, `watch.ts` |

## Phase 4: Performance

Measure first: `npm run eval -- --mode hybrid` latency (p50/p95) before Phase 4 and after each item.

| ID | Problem | Fix | Files |
|---|---|---|---|
| 4.1 | Every search calls `stats()`, which collects up to 1M hits via `allQuery` just to count. | `searcher.numDocs`; `ensureSynced` caches "non-empty" once true; read meta once. | `indexing/tantivy-index.ts`, `commands.ts` |
| 4.2 | Every search calls `listSessions()` on all adapters; Codex `findSessionFile` re-walks the tree (stat per file) per `listTurns`; cold sync is O(N²) stats. | Adapters keep an `id → sourcePath` map filled by `listSessions` (walk only on miss); `walkJsonl` uses `withFileTypes`; `SearchService` caches the session map, invalidated by sync/watch. | `adapters/codex.ts`, `adapters/claude.ts`, `search/search.ts` |
| 4.3 | Each watch tick runs `embedMissing` over every session (full parse + LanceDB scans). | `syncAll` returns the sessions it indexed; watcher embeds only those via `embedSessionTurns`. | `watch.ts`, `indexing/sync.ts` |
| 4.4 | LanceDB: one `mergeInsert` per 64 rows, never compacted (192 versions); `existing()` scans without an index on `id`. | Scalar index on `id`; `optimize()` after backfill/sync batches; larger write batches. | `indexing/vectors.ts`, `indexing/embed-sync.ts` |
| 4.5 | Tantivy commits + reloads once per session during sync; SQLite inserts without a transaction; `getTurnsByIds` runs one query per id. | Single commit per sync pass; SQLite batch in a transaction; `getTurnsByIds` via one `termSetQuery`. | `indexing/tantivy-index.ts`, `indexing/sqlite-index.ts`, `indexing/sync.ts` |
| 4.6 | Cross-encoder scores 15 pairs sequentially. | One batched forward pass over all pairs. Measure rerank latency before/after. | `search/rerank.ts` |
| 4.7 | Decision cues compile a `RegExp` per cue per sentence; strong hits recomputed in both passes. | Precompile cue regexes at module load; compute per-turn hits once. | `decisions/cues.ts`, `decisions/extract.ts` |
| 4.8 | Adapter turn caches are unbounded in the long-running serve. | Size-bounded LRU (by content bytes). | `adapters/claude.ts`, `adapters/codex.ts` |

## Phase 5: Remaining issues and cleanup

| ID | Item | Plan |
|---|---|---|
| 5.1 | SQLite FTS external-content table has no UPDATE trigger (upserts desync FTS). | Add `docs_au` trigger; one-time `INSERT INTO docs_fts(docs_fts) VALUES('rebuild')` migration. |
| 5.2 | ACL is skipped entirely when no principal is passed. | **Decision D3.** |
| 5.3 | `serve --announce` advertises on the LAN while binding 127.0.0.1. | **Decision D4.** |
| 5.4 | Decision anchoring rejects any turn containing `?` (code, URLs). | Question test on the anchor sentence, not the whole turn. |
| 5.5 | Neural judge reports `neural-judge` even when the reranker fell back. | Surface fallback; keep `heuristic` method in that case. |
| 5.6 | `GET …/turns/:id?window=N` ignores N; `asOf` doesn't exclude turns created after `asOf`; "between A and B" excludes day B. | Small targeted fixes + tests. |
| 5.7 | Dead code: legacy `finalScore` overload (`normalizeBase`/`normalizeVector`), `registry.ts` duplicates `app.ts`, `deriveFromTurns` unused (and would mass-invalidate on "replaced the …"). | Delete, or wire with fixes for `deriveFromTurns`. |
| 5.8 | README "Known MVP limits" section contradicts shipped phases. | Rewrite after fixes land. |

## Decisions needed

- **D1**: Legacy 1024-dim `turns` table (Ollama): keep as the Ollama-fallback table, or drop it once `turns_384` is fully backfilled?
- **D2**: Subscriptions: implement delivery (webhook + stored notifications) or remove the feature?
- **D3**: ACL without a principal: stay open (local-first default), apply the `*` rule, or require a principal whenever rules exist?
- **D4**: Federation/announce: make LAN binding real (opt-in host + mandatory token) or disable `--announce` until then?

## After the fixes (operational)

1. `gateway sync --rebuild` (fixes 1.1 and 1.4 change what gets indexed).
2. `gateway backfill` to fill `turns_384` (~96k turns at ~150/s ≈ 11 min).
3. Re-run eval per mode and commit the new `tests/eval/baseline.json`.
4. Restart the launchd server: `launchctl kickstart -k gui/$(id -u)/com.context-gateway.serve`.
