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

## After the fixes (operational) — done 2026-09-16

1. ✅ Restarted the launchd server on the new code.
2. ✅ `sync --rebuild`: 159 sessions, 107,236 turns, 100,084 docs, 0 failed.
3. ✅ Backfill: 82,546 turns embedded. The first run aborted at session 55 on a
   LanceDB "ambiguous merge insert" — Claude reuses turn uuids inside a file and
   the 512-row write buffer made a batch carry an id twice; `VectorStore.upsert`
   now dedupes (separate commit + test). `turns_384` holds 100,244 rows with a
   scalar `id` index.
4. ✅ D1: legacy `turns.lance` (12,211 rows, 53 MB) deleted after coverage was confirmed.
5. ✅ Eval re-run per mode; `tests/eval/baseline.json` regenerated from hybrid.

## Open observations (surfaced by the fixes, not in this plan's scope)

**These numbers are pinned** (`--as-of 2026-09-14`, the day after the golden set's
newest relevant turn). Nothing recorded above this section was. An unpinned run
scores against whatever happens to be indexed that minute — including the session
doing the evaluating, whose transcript quotes all 24 golden queries verbatim. The
same code path scored **0.7846** unpinned in one session and **0.6740** hours later
with no code change at all. Treat every earlier eval figure in this document,
including the before/after table above, as indicative only.

| Mode (pinned) | NDCG@5 | MRR@5 | P@1 | paraphrase | median latency |
|---|---:|---:|---:|---:|---:|
| lexical | 0.854 | 0.868 | 0.792 | 0.648 | 72 ms |
| **lexical + rerank** | **0.866** | **0.896** | **0.833** | **0.686** | 2556 ms |
| hybrid | 0.818 | 0.816 | 0.708 | 0.596 | 97 ms |
| hybrid + rerank | 0.863 | 0.889 | 0.833 | 0.676 | 2189 ms |

Re-measured after chunking landed (same `--as-of`, 2026-09-16). **Superseded — every row
here was measured while `asOf` was applied *after* the search, which muted the vector head
(see the correction below). Kept for the record, not for decisions.**

| Mode (broken pin) | NDCG@5 | MRR@5 | P@1 | paraphrase | p50 |
|---|---:|---:|---:|---:|---:|
| lexical | 0.841 | 0.847 | 0.792 | 0.611 | 74 ms |
| hybrid | 0.868 | 0.899 | 0.833 | 0.721 | 90 ms |
| lexical + rerank | 0.866 | 0.896 | 0.833 | 0.686 | 3016 ms |
| hybrid + rerank | 0.895 | 0.910 | 0.875 | 0.742 | 3435 ms |

All four modes have since been re-measured under the corrected pin; see the table below.

**Pinning is weaker than this document claimed.** The earlier note here said
`lexical` scored 0.8537 in two pinned runs an hour apart, so "pinning works". It
scored **0.841** in the run above — though nothing in the lexical path changed
(`chunkForEmbedding` is called only from `embed-sync`, `chunkTurnId` only from
`vectors.ts`). `--as-of` filters which turns may be *returned*; it does not pin
the BM25 corpus statistics. IDF and average document length shift as the watcher
indexes new sessions, which reorders results *within* the pinned subset. So
**cross-run deltas carry drift, and only within-run orderings are trustworthy.**
Every figure in both tables should be read with that caveat.

**`asOf` was also losing recall — a product bug, not just an eval artifact.** It was
applied *after* `index.search()` returned, but `limit` is applied *inside*. Newer turns
therefore took candidate slots and were then discarded, so the same `asOf` returned
fewer results as the corpus grew. Now bounded inside the query (`IndexFilter.
maxTimestampMs`, a Tantivy `rangeQuery` on the indexed `timestampMs` field, a
`d.timestampMs<=?` predicate in SQLite, and the same bound pushed into LanceDB, which
prefilters by default). Regression test: 60 newer high-scoring turns bury one older
match; at `limit: 50` the old turn is unreachable before the fix, on both backends.

**This corrected the numbers downward, and the correction is the point.** With the bound
applied properly, pinned hybrid is **0.831**, not the 0.868 recorded above, while lexical
is unchanged at 0.841:

| Mode (correctly pinned) | NDCG@5 | MRR@5 | P@1 | paraphrase | p50 |
|---|---:|---:|---:|---:|---:|
| lexical | 0.841 | 0.847 | 0.792 | 0.611 | ~120 ms |
| hybrid | 0.831 | 0.851 | 0.792 | 0.609 | ~166 ms |
| lexical + rerank | 0.861 | 0.889 | 0.833 | 0.669 | 3191 ms |
| **hybrid + rerank** | **0.885** | **0.913** | **0.875** | **0.713** | 3160 ms |

**Vectors earn their place only behind a reranker.** Unaided they cost a little (hybrid
0.831 vs lexical 0.841); reranked they clearly pay (0.885 vs 0.861, paraphrase 0.713 vs
0.669). That is coherent: vectors buy recall into the candidate pool and the cross-encoder
supplies the precision to sort it out, whereas un-reranked their noise lands directly in
the final ranking. Both rerank modes survived the corrected pin nearly intact (0.895 →
0.885, 0.866 → 0.861), so the artifact was concentrated exactly where vectors ranked
unaided. The withdrawal below therefore applies to the *un-reranked* comparison;
`hybrid + rerank` remains the best configuration measured, at ~3.2 s per query.

The likely mechanism, consistent with a direct probe: the strongest vector hits were
*post-cutoff* turns — this evaluator's own transcript, which quotes the golden queries
verbatim (top similarity 0.809 unfiltered vs 0.694 filtered). Those hits consumed vector
rank positions and were then dropped by the post-filter, leaving legitimate turns with
worse ranks and weaker RRF influence. Correct pinning gives vectors their full influence,
and hybrid gets *worse* — which is evidence the vector head is still not accurate enough
on this corpus. **So "hybrid overtook lexical" is withdrawn**: it was an artifact of a
broken pin. Production is unaffected (no `asOf` means no predicate); what changed is that
the eval stopped flattering the vector path.

Two pinned passes were bit-identical across every metric, but the index shrank 28 KB
between them (a segment merge, not growth), so that is consistent with reproducibility
rather than proof of it. The BM25-statistics drift above remains unfixed.

- **The BGE query prefix was half the vector problem, and it is fixed.** Queries now
  carry BGE's retrieval instruction; passages stay bare, so no re-embedding was needed.
  Worth +0.038 NDCG@5 on hybrid (0.780 → 0.818), paraphrase 0.538 → 0.596. The other
  half of the old hypothesis — embed the natural question rather than the stripped
  `indexQuery` — was measured and **dropped**: +0.003 (noise), and on a zero-overlap
  paraphrase it drags the vector toward a distractor ("how SHOULD teammates jointly
  EDIT" pulls to "Monaco EDITOR SHOULD be replaced").
- **Vectors still cost quality on this set, and the apparent reversal did not survive a
  correct pin.** Chunking genuinely helped — it is what made a stored vector describe the
  text it is filed under — and under the old (post-filtered) pin hybrid appeared to
  overtake lexical at 0.868 vs 0.841. Once `asOf` was bounded inside the query, hybrid
  measured **0.831** against lexical's unchanged 0.841, paraphrase 0.609 vs 0.611 — so
  un-reranked, the ordering is where it always was: lexical narrowly ahead. But the
  comparison flips once a cross-encoder is in play (hybrid + rerank 0.885 vs
  lexical + rerank 0.861). The shipped `semantic: true` default is therefore right when
  reranking and marginally wrong without it, which makes the honest answer "it depends on
  the pipeline" rather than a single flag — still on 24 queries of one corpus.
- **The embedder never sees most of a long turn — this is the structural reason vectors
  lose.** BGE-small's window is 512 tokens (`model.max_length`), but `truncate()` keeps
  8000 chars and we embed the turn whole. Probed directly: appending 400 tokens of
  unrelated text to an 842-token document returns a *bit-identical* vector
  (`cos = 1.00000`), while a short control moves (0.874). So everything past ~2000 chars is
  silently discarded. That is 12% of Claude turns but **32% of every character we index**,
  concentrated in the long turns that hold plans and verdicts — and BM25 reads all of it.
  No threshold tuning reaches this: the fix is to split turns into ≤512-token chunks, embed
  each, and keep the best-scoring chunk per turn (which also makes `MIN_VECTOR_SIM`
  meaningful, since today a long turn's similarity is computed against a fragment).
  **This has now landed** (`chunkForEmbedding`, 1600-char windows with 200-char overlap;
  window 0 keeps the bare turn id so existing rows stay valid and a long turn embedded
  earlier gains only its missing tail; `VectorStore.nearest` over-fetches 4× and max-pools
  windows back to turns). The backfill grew the store 100,244 → 139,403 rows (+39,159
  windows, +39%) in 768s. Every measurement of "do embeddings help" taken before this —
  including the +0.038 from the query prefix — was measuring a crippled index, not the model.
- **The similarity gate is not a lever, and today it does nothing.** `MIN_VECTOR_SIM = 0.45`
  never fires: all 1200 candidates (24 queries × 50) clear it, so the "prevents spurious
  vector hits" comment describes a mechanism that does not operate. Swept on the pinned
  corpus, hybrid NDCG@5 goes 0.45 → 0.8178, 0.70 → 0.8217, 0.78 → 0.8470, 0.85 → 0.8537 —
  monotonically better the more vectors are excluded. The 0.85 endpoint equals lexical-only
  to four decimals because only 17 of 1200 candidates survive and 21 of 24 queries get no
  vector input at all: it *is* lexical, wearing a costume. Left at 0.45 rather than shipping
  "vectors off" disguised as a tuned threshold. **That whole sweep is void**: it measured a
  truncated index, and on the chunked index excluding vectors is no longer free. The gate
  has not been re-swept — if it is ever tuned, it must be measured on the chunked index.
- **The prefix gain is reordering, not filtering.** Checked directly: prefixed and bare
  queries both pass 1200/1200 candidates, so the +0.038 is not the gate suppressing weak
  hits. Worth noting the BAAI card says `bge-*-v1.5` was improved to work *without* the
  instruction and omitting it causes only "slight degradation" — our +0.038 is larger than
  the vendor leads you to expect, on 24 queries. Their own advice is to pick by task
  performance, which is what was measured.

### What the literature says (2026-09-16)

- **Late chunking** ([2409.04701](https://arxiv.org/abs/2409.04701)) embeds the whole
  document first and pools per chunk afterwards, keeping cross-chunk context. It *requires*
  a long-context encoder, so it is unavailable to `bge-small-en-v1.5` (confirmed 512 tokens,
  registry repo `BAAI/bge-small-en-v1.5`). The fork is plain pre-chunking (works today) vs
  swapping to `jina-embeddings-v3` (8192 tokens, native late chunking, query/passage LoRA
  adapters) or `nomic-embed-text` (8192) — at ~17× bge-small's parameters.
- **BM25 beating dense is not anomalous** ([2604.01733](https://arxiv.org/html/2604.01733v1)):
  BM25 outperforms `text-embedding-3-large` on financial text-and-table corpora, where exact
  terminology dominates — much like code identifiers and file paths here. Note their dense
  model has an 8191-token window and their hybrid *wins*; ours truncates at 512 and loses.
- **Convex-combination fusion may beat RRF**: same benchmark reports CC α=0.5 Recall@5 0.726
  vs RRF k=60 0.695. [2601.20131](https://arxiv.org/html/2601.20131v1) notes α≈0.5 is a good
  default but "the optimal operating point is highly domain-dependent". We use RRF; worth an
  A/B once vectors are worth fusing at all.
- **Adaptive reranking is real, but the cheap trigger is not**
  ([2606.25249](https://arxiv.org/html/2606.25249)): routing gives 1.15–53× lower median
  latency, and only 11.6% of queries need a heavy reranker (59.2% need none). But BM25-derived
  signals correlated only ρ=0.06–0.14 with the right routing decision, so they trained a
  classifier on 306,544 queries. A "rerank when the top scores are close" heuristic is the
  approach that paper found insufficient.
- **`decide` should not be cue matching.** Decision detection in multi-party dialogue has
  modelled *decision sub-dialogues with utterance roles* since Fernández et al. (SIGdial
  2008), outperforming flat annotations; the LLM argument-mining survey
  ([2506.16383](https://arxiv.org/html/2506.16383v1)) reports dialogue-act context,
  chain-of-thought and graph methods over surface markers.
- **Our citation metric is not ALCE.** Real ALCE scores citation precision/recall by NLI
  *entailment* between cited text and the claim. `evaluateCitations` does set overlap on
  session ids and never reads the cited text — which is exactly why it rewarded raw file
  dumps. Rename it or implement entailment before treating it as a gate.
- **Reranking over *lexical* candidates is the best configuration measured** (0.866,
  P@1 0.833, paraphrase 0.686), and it beats plain lexical with **zero regressions**
  (paired: 2 queries better, 0 worse). Giving the reranker vector candidates instead is
  worse on every axis and loses a query outright (`paraphrase-17`, −0.080) — so the vector
  pool is not useful even as reranker feed while turns are truncated. What keeps reranking
  off by default is latency, not quality: ~2.5 s p50 against 72 ms for lexical. Worth
  measuring before adopting it as the default, cheapest first: `RERANK_POOL` 15 → 8, an
  adaptive trigger (only rerank when the top lexical scores are close), and caching scores
  per (query, turnId). `lexical-rerank` is now an eval mode, so each is measurable.
- **`decide` no longer quotes files — and the citation metric punished that.** Tool
  results reach the adapters as `user` lines, so a third of the Claude corpus (26,484 of
  78,629 turns) was read as user speech and extraction anchored on file contents. Those
  lines now carry role `tool`. Isolated on the pinned corpus, the fix *lowers* ALCE
  citation precision 0.133 → 0.067 (recall flat) because the citations it removes are
  raw file dumps — a Read result, a diffstat — that happen to sit in a relevant session.
  ALCE scores session ids and never asks whether the cited text is a decision, so it was
  paying for garbage. Retrieval is unaffected (0.8178 with and without): `role` is not a
  ranking input.
- **`decide`'s real weakness is the cue heuristics, not the tool leak.** Post-fix verdicts
  are genuine prose but still not decisions ("Now I've got it grounded" for a
  Monaco/CodeMirror query), at confidence 0.11–0.26. The 0.000 citations recorded earlier
  were corpus contamination, not the anchoring bug — that attribution was wrong.
  **Contamination is no longer a sufficient explanation either.** On the chunked corpus,
  pinned, all four modes score citation precision *and* recall 0.000 — where the previous
  pinned hybrid baseline recorded 0.067/0.200. Chunking cannot be the cause: `lexical`
  reports 0.000 too, and nothing in this change touches the lexical path. It is the same
  BM25-statistics drift described above, amplified by a metric thin enough that one
  citation swings the mean by 0.067. `decide` is not producing citable decisions, and this
  metric is too unstable to tell us when that changes.
- **The citation metric is too thin to gate on**: 5 why-queries, ≤3 citations each, so a
  single citation moves the mean by 0.067 in either direction.
