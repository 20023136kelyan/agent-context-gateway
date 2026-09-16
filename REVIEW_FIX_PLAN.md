# Review Fix Plan

Source: xhigh code review of the whole codebase (2026-09-16).
Baseline commit: `c3ef061` · `tsc --noEmit`: clean · tests: 110/111 pass. The one failure (`tests/discovery.test.ts`, mDNS announce/discover) is pre-existing and most likely environmental (multicast unavailable in the sandbox); it is not caused by the fixes below.

## Ground rules

- Work on branch `review-fixes`; one commit per item (or a tight group), message names the item ID.
- Every correctness fix lands with a regression test that fails on the baseline and passes after.
- After each commit: `npx tsc --noEmit` and `npm test` stay green.
- No drive-by refactors inside a fix commit. Cleanup has its own phase.
- Performance items are measured before/after (eval latency p50/p95, plus targeted timings noted per item).

## Decisions (answered 2026-09-16)

- **D1 Legacy vectors**: drop the 1024-dim `turns` table once `turns_384` is fully backfilled. MLX failure then degrades to lexical-only instead of a partial, stale table. (Deleting it is confirmed again at the time.)
- **D2 Subscriptions**: implement delivery (item 3.6).
- **D3 ACL without a principal**: apply the `*` rule when one exists; stay open when there is none (item 5.2).
- **D4 Federation**: make LAN serving real: opt-in bind address, mandatory token off-loopback, announce advertises the bound address (item 5.3).

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
| 2.3 | Loopback HTTP API has no Host/Origin checks and no token by default: CSRF (`POST /sync?rebuild=true`, `/feedback`) and DNS-rebinding reads of `/search`. | `onRequest`: allow only `127.0.0.1:<port>` / `localhost:<port>` Hosts, plus the bound LAN address when 5.3 is enabled (extendable via `GATEWAY_ALLOWED_HOSTS`); reject non-GET requests carrying a non-loopback `Origin`. Swift app and CLI unaffected. | `inject` with `Host: evil.test` → 403; POST with `Origin: https://evil.test` → 403; normal CLI/Swift requests → 200. | `transports/http.ts` |

## Phase 3: Search correctness

| ID | Problem | Fix | Test | Files |
|---|---|---|---|---|
| 3.1 | MLX worker script resolved from `process.cwd()`: MCP server and hooks (other cwds) silently use Ollama and query the legacy table. | Resolve from `import.meta.url`. | `isAvailable()` true after `chdir` to a temp dir. | `embeddings/mlx.ts` |
| 3.2 | MLX worker startup failure stalls every embed call 8s; no per-request timeout (a wedged worker hangs search). | Reject the ready promise on exit/spawn error; cool-down flag skips MLX for 60s after a failure; per-request timeout kills and resets the worker. | Fake venv python that exits 1 → `embedTexts` rejects in <1s; second call within cool-down doesn't respawn. | `embeddings/mlx.ts` |
| 3.3 | Rerank rescored only the top 15 and re-sorted them against raw tail scores (different scales): the tail can outrank reranked results. | Reranked slice keeps its order; tail is placed after it (scores mapped below the reranked minimum). | Stub reranker scoring everything low → top results still come from the reranked slice. | `search/search.ts` |
| 3.4 | Topology rewrite uses the harness *filter* as the caller's harness (defaults to `claude-code`); resolved targets always report scope `parent`. | Resolve the caller's harness from the session map before rewriting; rewriter returns the matched relation. | Codex caller with a parent link, no harness filter → "my parent" resolves; child reference reports `children`. | `search/search.ts`, `search/rewriter.ts` |
| 3.5 | Eval `--mode lexical` still attaches vectors via `searchOnce`; all modes run the same pipeline, so the committed baseline can't compare them. | `SearchOptions.semantic` (default true) honored by `SearchService` and `searchOnce`; runner maps modes: `lexical` (no vectors), `hybrid` (vectors + RRF), `rerank` (hybrid + cross-encoder; `rrf` kept as an alias of `hybrid`). Regenerate `tests/eval/baseline.json`. | Lexical mode → vector store never queried (spy). | `search/search.ts`, `commands.ts`, `eval/runner.ts`, `scripts/run-eval.ts` |
| 3.6 | Subscriptions are stored but never evaluated or delivered (`notifyTurns` has no caller). | **D2: implement.** `syncAll` reports turns that are new to the index (ids absent before the batch); watcher and `POST /sync` pass them to `notifyTurns`; matching uses `normalizeQuery` terms (same stop-words as search). Webhook delivery: http/https only, 5s timeout, fire-and-forget with errors logged; last 20 notifications kept per subscription and returned by `GET /subscriptions` and the MCP list. | New matching turn → local test webhook receives the payload; non-matching turn → nothing; bad URL scheme rejected at subscribe time. | `collaboration/live.ts`, `indexing/sync.ts`, `watch.ts`, `transports/http.ts`, `transports/mcp.ts` |

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
| 5.2 | ACL is skipped entirely when no principal is passed. | **D3:** anonymous callers get the `*` rule when one exists; no `*` rule → open (local use unchanged). Tests: `*` rule restricts anonymous search; no rules → unchanged results. |
| 5.3 | `serve --announce` advertises on the LAN while binding 127.0.0.1. | **D4:** `serve --host <addr>` (default `127.0.0.1`). A non-loopback bind refuses to start without `GATEWAY_TOKEN`; off-loopback `/health` returns only `{ok}` without a token; the bound host joins the 2.3 allowlist; `--announce` advertises the bound address and refuses on a loopback bind. Remotes keep sending their stored token. Tests: non-loopback bind without token → startup error; with token → unauthenticated `/search` 401, authenticated 200. |
| 5.4 | Decision anchoring rejects any turn containing `?` (code, URLs). | Question test on the anchor sentence, not the whole turn. |
| 5.5 | Neural judge reports `neural-judge` even when the reranker fell back. | Surface fallback; keep `heuristic` method in that case. |
| 5.6 | `GET …/turns/:id?window=N` ignores N; `asOf` doesn't exclude turns created after `asOf`; "between A and B" excludes day B. | Small targeted fixes + tests. |
| 5.7 | Dead code: legacy `finalScore` overload (`normalizeBase`/`normalizeVector`), `registry.ts` duplicates `app.ts`, `deriveFromTurns` unused (and would mass-invalidate on "replaced the …"); legacy `turns` table handling in `VectorStore` becomes dead after D1. | Delete, or wire with fixes for `deriveFromTurns`. |
| 5.8 | README "Known MVP limits" section contradicts shipped phases. | Rewrite after fixes land; document `--host`, token requirement, subscriptions. |

## Outcome (2026-09-16)

All five phases are implemented on `review-fixes`, one commit per item or tight group,
each with regression tests that fail on `c3ef061` and pass after. Suite: 154 tests
(from 111), `tsc --noEmit` clean.

Deviations and extras found while implementing:

- **4.6 reverted.** Batching the cross-encoder made it *slower* (15 pairs: 2.7 s
  batched vs 1.7 s one pass per pair) because every pair is padded to the longest.
  Reverted with the measurement recorded in the code comment.
- **4.8 re-sized after measuring.** The first bound (128 sessions / 50M chars) was
  below the working set — the corpus is 106M chars with a single 51M-char Codex
  session — and thrashed: 24 queries went 4.0 s → 31 s. Now 256 sessions / 200M
  chars; the whole corpus retains 222 MB of heap. A `truncate()` copy meant to cut
  retention was tried and dropped: measured identical heap.
- **Extra bug (git hook):** `diff-tree` needs `--root` or a repo's first commit
  records no files.
- **Extra bug (MLX):** an idle worker's pipes kept Node alive, so any process that
  embedded once (CLI search, run-eval, bench) finished its work and never exited.
- **Extra bug (Tantivy):** `search()` was computing a total match count that no
  caller used.

Measured before/after (`scripts/bench.ts`, medians, 159 sessions / ~107k turns):

| Operation | Before | After |
|---|---:|---:|
| `index.stats()` (every search) | 37.5 ms | 0.2 ms |
| Codex `listTurns` ×5, warm | 21 ms | 0.1 ms |
| 24 golden queries, lexical | 3957 ms | 2692 ms |
| 24 golden queries, hybrid | 1972 ms | 822 ms |
| `extractDecisions`, 2529 turns | 308 ms | 44 ms |
| Cold full sync | 52.7 s | 12.8 s |
| Incremental sync, no changes | 46.8 ms | 14.3 ms |

## After the fixes (operational)

1. `gateway sync --rebuild` (fixes 1.1 and 1.4 change what gets indexed).
2. `gateway backfill` to fill `turns_384` (~96k turns at ~150/s ≈ 11 min).
3. D1: once `turns_384` covers the index, drop the legacy `turns` table (confirm first).
4. Re-run eval per mode and commit the new `tests/eval/baseline.json`.
5. Restart the launchd server: `launchctl kickstart -k gui/$(id -u)/com.context-gateway.serve`.
