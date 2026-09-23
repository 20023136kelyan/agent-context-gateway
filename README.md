# Agent Context Gateway

**Federated semantic search over native agent work histories — not another memory database.**

One agent asks *"What did Codex decide about the collaboration architecture?"* and gets
the relevant turns from Codex's own history, with provenance. No manual memory writes,
no whole-context handoffs, no central source of truth beyond the native histories.

Full concept: [`Agent Context Gateway — Project Specification.md`](./Agent%20Context%20Gateway%20—%20Project%20Specification.md) (§1–80).
Build plan: [`IMPLEMENTATION_PLAN_V2.md`](./IMPLEMENTATION_PLAN_V2.md).
Review fixes: [`REVIEW_FIX_PLAN.md`](./REVIEW_FIX_PLAN.md).
Fixture corpus: [`FIXTURE_CORPUS_BRIEF.md`](./FIXTURE_CORPUS_BRIEF.md).

## Status: 0.2.0 — locked Voyage/Jev stack

- [x] MVP — adapters (Claude Code, Codex), Tantivy/SQLite, hybrid search, CLI/HTTP/MCP, acceptance test, watcher, hooks
- [x] Phase 2 — background serve with port-delegation, topology links (`parent|children|siblings|auto`), Cursor adapter, repo-root awareness, bearer auth & read-only federation, artifact polish
- [x] Phase 3 — heuristic decision extraction, bi-temporal reasoning, artifact graph BFS, feedback ranking, mDNS discovery, native SwiftUI menu-bar app
- [x] Phase A — domain-stratified golden benchmark, evaluation runner, NDCG/MRR/ALCE metrics
- [x] Phase B — CAsT conversational query rewriting, RRF fusion with similarity calibration, reranking, multi-hop BFS graph traversal
- [x] Phase C — Derived bi-temporal invalidation markers (non-destructive supersession, point-in-time `asOf` queries), resource-level ACLs
- [x] Phase E — Zep Context Lake adapter (`harness: "zep"`)
- [x] Phase F — Real-time live active-session search (bypassing index), context subscriptions & webhook delivery, full agent lineage explorer
- [x] Review fixes (2026-09-16) — correctness, security and performance pass over the whole codebase; see [`REVIEW_FIX_PLAN.md`](./REVIEW_FIX_PLAN.md)
- [x] 0.2.0 (2026-09-22) — Voyage embeddings, Jev reranker and decision judge, component registry, OpenCode and trajectory adapters, sqlite-vec backend (Intel Macs), fixture/BEIR eval program and sweep harness, `init`/`doctor`/`models`/`stats`/`telemetry`
- [x] Stack focus (2026-09-23) — local fallbacks deleted: MLX and Ollama embedders, ONNX cross-encoder, neural-entailment and Apple FM judges. They were measured and lost (see [Reranking](#reranking)).

## Quickstart

```bash
npm install
cp .env.example .env          # optional: VOYAGE_API_KEY, TYPESAFE_API_KEY
npx tsx src/cli.ts init       # detects histories, sets keys, syncs, backfills, installs hooks, verifies
npx tsx src/cli.ts search "What did Codex decide about collaboration?"
npx tsx src/cli.ts health
npx tsx src/cli.ts doctor     # histories, keys, index, vectors, models in one report
npx tsx src/cli.ts models     # locked stack vs what resolves here, availability, prices
npx tsx src/cli.ts config     # effective tunables (flag > env > settings.json > default)
npx tsx src/cli.ts stats      # shape-only usage aggregates (never content)
```

No key is required. Without keys the gateway runs lexical-only: no vectors, no
reranking, and decision verdicts stay labelled as heuristic candidates.
`npm run dev -- <command>` is the same CLI with `.env` loaded.

HTTP (loopback) and MCP:

```bash
npx tsx src/cli.ts serve --port 3000   # http://127.0.0.1:3000/{health,sources,sessions,search,sync}
npx tsx src/cli.ts mcp                # stdio MCP server: context.search, context.get_turn, …
```

## The model stack

Every swappable piece lives in one registry, [`src/components.ts`](./src/components.ts).
Types, resolution order, settings allow-lists and sweep cost basis all derive from it.

| Role | Locked | Also available (pin only) | Opt-in key |
|---|---|---|---|
| Embeddings | `voyage` (voyage-4, 1024-dim) | `voyage-code`, `voyage-context` | `VOYAGE_API_KEY` |
| Reranker | `jev` (pairwise) | `voyage` (rerank-2.5), `none` | `TYPESAFE_API_KEY` / `VOYAGE_API_KEY` |
| Decision judge | `jev` | `heuristic` | `TYPESAFE_API_KEY` |

"Locked" is the measured production stack. Unpinned resolution is
first-available-wins: rerankers are tried `jev` then `voyage`, so a user with only
`VOYAGE_API_KEY` gets Voyage reranking (off by default, opt in per request).
Voyage stays pin-only until a bake-off against Jev. `gateway models` prints the
locked and resolved stack. Pin with `GATEWAY_EMBED_ENGINE`, `GATEWAY_RERANKER` and
`GATEWAY_JUDGE`. A pin never falls back, so a deployment cannot silently switch
vendors mid-corpus.

**Privacy.** Every model in the stack is remote. Setting a key is the opt-in, and
it is a deliberate departure from the spec's local-first principle (§73.5):
Voyage sees the turn text you backfill plus each query; Jev sees each query plus
candidate excerpts on every reranked search or `decide`.

Everything bound for either vendor is scrubbed first (`src/security/scrub.ts`):
API keys and tokens, private keys, JWTs, auth headers, passwords in URLs and
named credentials, plus emails and non-loopback IPv4 by default
(`GATEWAY_SCRUB=all|secrets|off`). Text is scrubbed before it is chunked or
truncated, since a key split in half is unrecognisable. The local index and
your histories are never altered, so an exact search for a string you pasted
still works locally.

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

## Project scope

By default a search runs in **the project the agent is working in**, across
every harness. Measured on real agent history (friends' Claude Code and Codex
sessions; "does search find the earlier session that already did this work?"),
scoping is the largest single gain in the pipeline:

| NDCG@5 | Keyword | Hybrid | Hybrid + Jev |
|---|---:|---:|---:|
| All projects (previous default), 14 queries | 0.225 | 0.327 | 0.447 |
| Caller's project, 14 queries | 0.723 | 0.726 | **0.781** |
| All projects, 27 queries | 0.196 | 0.259 | 0.324 |
| Caller's project, 27 queries | 0.569 | 0.574 | **0.616** |

An in-project request ("is the app finished?") is unanswerable across every
project at once. The labels are same-project by construction, so these numbers
cannot show what scoping costs a cross-project ask; use `"*"` for those.

- **Which project:** the name of the git repo around the MCP server's or CLI's
  working directory (harnesses start stdio MCP servers in the agent's
  directory), or the directory's own name outside a repo. Nothing in the home
  directory or at `/`.
- **Across harnesses and machines:** matched by folder name, ignoring case and
  punctuation, so a repo that is `-Users-alice-dev-app` to Claude Code, `app`
  to Codex and `App 2` on another machine counts once as long as the names
  agree. An exact `projectId` still matches.
- **Widening:** `project: "*"` (MCP, HTTP) or `--all-projects` (CLI) searches
  everything. An explicit `project` always wins.
- **No history yet:** if the caller's project has no sessions, search falls back
  to all projects rather than returning nothing.
- **Not applied** to topology scopes (`parent`, `children`, `siblings`, `auto`),
  whose linked sessions may span projects, or to HTTP callers that do not send
  `defaultProject` (a shared daemon cannot see its caller's directory).

Every search and decide response carries `projectScope`
(`{project, source: "explicit" | "caller" | "all"}`), so an agent can see how its
results were scoped and widen them. `preferProject` is a softer mode (also
search the rest, boost the project); it currently loses to the filter because
the Jev reranker does not know the caller's project.

## What agents did: the action index

Search ranks what agents *said*. "Has another agent already changed
`client.ts`?" or "who ran the migration?" have exact answers in the tool calls
instead, so those live in a separate index: every file an agent edited and every
command it ran, with the session, the time, and the turn to open for context.

```bash
npx tsx src/cli.ts actions --file client.ts          # which sessions edited it (path tail matches)
npx tsx src/cli.ts actions --command "db:migrate"    # which sessions ran it
```

MCP `context.find_actions`, HTTP `GET /actions?file=&command=`. Scoped like
search (the caller's project by default, `"*"` / `--all-projects` for every
project), newest first, no model involved.

Read from Claude Code (`Edit`, `Write`, `MultiEdit`, `NotebookEdit`, `Bash`)
and Codex (`apply_patch`, shell and `exec_command` calls, and commands and
patches inside Codex Desktop's code-mode `exec` scripts). On a 98-session real
corpus it held 14k actions, lookups took 4-18 ms, and its edits agreed with an
independent parser on all 61 editing sessions (mean Jaccard 0.93).

Tool calls are kept **out of the search ranking** on purpose. Indexed as their
own turns they crowded the rerank pool: on real history the Jev pipeline fell
from 0.613 to 0.555 NDCG@5 (Claude calls, 7 runs) and hybrid from 0.574 to 0.548
(Codex shell calls). They still show in result context windows.

## Proactive context (opt-in)

Instead of waiting for an agent to search, a Claude Code `UserPromptSubmit`
hook can put related earlier work in front of it as the prompt is sent:

```text
Related work from earlier agent sessions in this project (Agent Context Gateway).
Open one with context.get_context(harness, sessionId, turnId) if it is useful; ignore it otherwise.
- codex session 01a06e01 (2026-09-04) edited backend/silwall/risk.py (2 matching edits) [turn …]
- claude-code session 6ce460c8 (2026-09-22) "Scrub secrets from everything sent to Voyage and Jev" [turn …]
```

```bash
npx tsx src/cli.ts init --proactive     # installs the hook next to the SessionEnd sync hook
```

For each prompt it skips slash commands and acknowledgements, retrieves a few
earlier sessions **from the caller's project** (never its own session), and
asks Jev one yes/no question per candidate: would this help with the request?
Only candidates at or above 0.7 are injected, at most three, never the same
session twice in one conversation. Files the prompt names add exact facts from
the action index. Without a Jev key it never injects search results. It gives
up silently after 8 s and always exits 0, so it can never block a prompt.

Measured on opening prompts from real history (`npm run eval:proactive`):
at 0.7, about 6 in 10 injections are relevant, and it finds the right earlier
session for 26-43% of prompts. On prompts whose project has no related history
it speaks up about a third of the time; read by eye, some of those were
relevant anyway. Useful, not sharp: which is why it is opt-in, and why the
injected text tells the agent to ignore it when it does not help.

**Privacy:** every non-trivial prompt is sent, scrubbed, to Voyage (embedding)
and Jev (the gate). Median cost is about a second per prompt, with a slow tail.

## Decisions

Why-questions go to `decide` (`context.decide`, `GET /decide`), not search:

```bash
npx tsx src/cli.ts decide "Why did we reject Monaco?"
```

Two-stage architecture:
1. Heuristic recall scans discussion regions for decision shape (conclusion, rationale, alternatives, question) with speech-act and relevance gating: conversational roles only, whole-word cues, sentence-scoped matching, no heading anchors, speaker-or-colon form, no attributive adjectives ("the selected session" ≠ "we selected X"). Only sentences that *end* in "?" count as questions, so a URL or `?.` in a turn no longer hides a verdict. Cues come from per-locale packs (`src/decisions/locales/`, `GATEWAY_LOCALE`, default `en`).
2. The Jev judge (`src/judgments/judge-jev.ts`) asks two typed questions per candidate: does this passage answer the query, and is it proposed, decided or reversed? The second keeps a session that merely restates open topics out of the citations. Without `TYPESAFE_API_KEY` the verdict keeps its `heuristic` label instead of claiming a judgement that never happened.

Every claim carries source turn IDs. Confidence blends shape-completeness with
*relevance*: verdicts sharing no query terms collapse to ~0.3 (low-confidence
leads) instead of parading as answers. On the fixture corpus, the Jev judge takes
decision-citation Hit@1 from 0.381 (the deleted neural-entailment judge) to 0.952.

## Semantic search

Lexical search matches words, not meaning. Embeddings add paraphrase-level recall:

- **Engine: Voyage** (`voyage-4`, 1024-dim) when `VOYAGE_API_KEY` is set. The
  provider asserts the returned width and throws on a mismatch, so a wrong
  model/dim pairing cannot write a foreign vector space into a valid-looking table.
- **Storage:** LanceDB, or sqlite-vec where Lance's native addon is missing. That
  is always the case on Intel Macs, since LanceDB dropped darwin-x64 after 0.22.3.
  Force one with `GATEWAY_VECTOR_BACKEND=lance|sqlite`.
- **Chunking:** turns are embedded in ~1600-char windows (`GATEWAY_CHUNK_CHARS`),
  so one long turn becomes several vector rows.

Each engine writes its own table (`turns_voyage_1024`, `turns_voyage_code_1024`).
Vector width is not an identity, so tables are keyed by engine. Backfill pins one
engine per run so a session cannot scatter across tables. Tables from the deleted
MLX/Ollama engines are ignored; backfill re-embeds under the live engine.

```bash
npx tsx src/cli.ts backfill              # resumable; compacts and indexes ids when done
npx tsx src/cli.ts search "…" --json     # add ?semantic=false (HTTP) or semantic:false (MCP) for lexical only
```

Hybrid ranking fuses Tantivy BM25 and cosine similarity with RRF, plus
project/repo/recency/entity/feedback boosts. Missing vectors degrade to lexical.
Vectors live under the state dir (`~/.context-gateway` by default), disposable
like the lexical index. The similarity floor and ramp (`GATEWAY_SIM_FLOOR`,
`GATEWAY_SIM_SPAN`, `GATEWAY_MIN_VECTOR_SIM`) are calibrated for voyage-4:
re-sweep them before trusting another engine.

## Reranking

The top 30 fused candidates (`GATEWAY_RERANK_POOL`) go to the installed reranker.
Whether a request reranks when it doesn't say is decided per reranker: **on for
Jev, off for Voyage and `none`**. `?rerank=true|false`, `--no-rerank` or MCP
`rerank` override it; `GATEWAY_RERANKER=none` turns it off everywhere.

Why these components, measured on BEIR nfcorpus (3633 real documents, 100 judged queries):

| Arm | NDCG@5 | p50 |
|---|---:|---:|
| lexical | 0.374 | 6 ms |
| hybrid, no rerank | 0.445 | 318 ms |
| local ONNX cross-encoder, pool 30 (deleted) | 0.433 | 6984 ms |
| Jev pairwise | 0.489 | 620 ms |

The cross-encoder landed *below* plain hybrid on real document lengths while
costing seconds, and a smaller pool recovered none of it. That is why it was
deleted rather than kept as a local fallback.

## Staying fresh (new chats)

Three layers, fastest first:

1. **Session-end hook (precise)** — sync exactly the session that just ended:
   ```bash
   npx tsx src/cli.ts sync-session claude-code "$SESSION_ID" --embed
   ```
   Claude Code (`~/.claude/settings.json`) — hooks receive JSON on stdin,
   so extract `session_id` with `jq`. `init` installs this for you:
   ```json
   { "hooks": { "SessionEnd": [{
     "hooks": [{ "type": "command",
       "command": "SID=$(jq -r .session_id); node --import tsx \"/path/to/ACG/src/cli.ts\" sync-session claude-code \"$SID\"" }]
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

`gateway.sh` is a stable entrypoint (resolves nvm's node, loads `.env`) for
launchd (`launchd/com.context-gateway.serve.plist`) and hooks.

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
  "command": ["node", "--import", "tsx", "/path/to/ACG/src/cli.ts", "mcp"]
} } }
```

Claude Code: `claude mcp add context-gateway -- node --import tsx /path/to/ACG/src/cli.ts mcp`.
Tools: `context.search`, `context.decide`, `context.find_actions`, `context.get_session`, `context.get_turn`,
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
npm run eval -- --fixture --mode lexical,hybrid,jev-pairwise,rerank-voyage
npm run eval -- --beir /path/to/beir/nfcorpus --mode hybrid,jev-pairwise
npm run sweep -- sweeps/example.json
```

- **Corpora.** A 72-session synthetic fixture corpus (`tests/fixtures/corpus.ts`,
  68 golden queries in `tests/eval/golden-fixture.json`), SWE-Gym-style
  trajectories, and BEIR datasets (`src/eval/beir.ts`) — corpora nobody here
  wrote, to check that constants tuned on the fixture hold up.
- **Real history.** `scripts/mine-pairs.ts` mines "did an earlier agent already
  do this?" pairs from raw Claude Code and Codex histories: a session's opening
  request is the query, and earlier same-project sessions that edited the same
  files are the answers, each query seeing only history from before it began.
  `npm run eval -- --real <root> [--project-scope none|filter|prefer]` measures
  them. Keep `<root>` outside the repo: it holds real requests.
- **Arms.** `--mode` takes a comma-separated list and runs every arm in one
  process against one index, since BM25 statistics drift between processes.
  Arms: `lexical`, `hybrid` (`rrf`), `lexical-jev`, `jev`, `lexical-jev-pairwise`,
  `jev-pairwise`, `jev-pure` (reranker order only, no boosts), `rerank-voyage`,
  and judge arms `judge-heuristic`, `judge-jev`, `judge-jev-noul`.
- **Metrics.** NDCG@5, MRR@5, P@1, P@5, latency, ALCE citation metrics and judge Hit@1.
- **Sweeps.** `scripts/sweep.ts` runs manifest cells, each in its own env-isolated
  process, and writes quality *and* third-party cost per row to
  `sweeps/results.sqlite` (git-ignored).

`npx tsx scripts/bench.ts [--sync]` times the hot paths against the real local
histories (read-only).

A custom embedder track (domain-adaptive pretraining and contrastive triplets on
BGE-small) was tried and parked after both regressed; see
[`experiments/training/README.md`](./experiments/training/README.md).

## Architecture

```text
Claude Code ─┐
Codex ───────┤
Cursor ──────┤                       ┌─► Tantivy/SQLite (BM25) ─┐
OpenCode ────┼──► adapters ─► sync ──┤                          ├─► RRF + boosts ─► rerank ─► SearchService ─► CLI / HTTP / MCP
Zep ─────────┤   (read-only)         └─► Voyage ─► Lance/       │   (project, repo,   (Jev/     │
Trajectories ┤                             sqlite-vec vectors ──┘    recency, feedback) Voyage)   ▼
Git ─────────┘                                                               adapters (truth) for expansion + packaging
       native truth (never mutated)          disposable derived state
```

Principles (§73): native history is truth; provenance always; least context
necessary (summary + ±3-turn evidence + budgets); disposable index
(`sync --rebuild` reproduces it); no hallucinated context (extractive summaries only).
Local-first holds for storage and history; the models are remote and opt-in (see
[The model stack](#the-model-stack)).

## Measured performance (2026-09-16, 159 sessions / ~107k turns / 100k docs, M4)

Before/after the review-fix pass (`scripts/bench.ts`, medians). Rows that measured
the since-deleted local models are omitted; see [Reranking](#reranking) for the
current retrieval numbers.

| Operation | Before | After |
|---|---:|---:|
| `index.stats()` (called on every search) | 37.5 ms | 0.2 ms |
| Codex `listTurns` ×5, caches warm | 21 ms | 0.1 ms |
| 24 golden queries, lexical | 3957 ms | 2692 ms |
| `extractDecisions` over a 2529-turn session | 308 ms | 44 ms |
| Cold full sync | 52.7 s | 12.8 s |
| Incremental sync, no changes | 46.8 ms | 14.3 ms |

## Layout

```text
src/core/           Agent/Session/Turn/Provenance model + stable IDs, LruCache
src/adapters/       claude, codex, cursor, opencode, zep, trajectories, git, text (chunking), repo
src/components.ts   component registry: engines, rerankers, judges, locked stack, prices
src/settings.ts     typed config (flag > env > settings.json > default)
src/embeddings/     provider.ts (engine registry + query-vector cache), voyage.ts, voyage-context.ts
src/indexing/       tantivy-index.ts, sqlite-index.ts, vectors.ts (LanceDB), vectors-sqlite.ts (sqlite-vec),
                    vector-backend.ts, sync.ts, embed-sync.ts, store.ts (cursors)
src/search/         query.ts, rank.ts (RRF), rewriter.ts (CAsT), reranker.ts (selection + contract),
                    rerank-voyage.ts, route.ts (experimental retrieval router, eval-only), search.ts
src/judgments/      jev.ts (TypeSafe client), rerank-jev.ts, judge-jev.ts
src/decisions/      cues.ts, locales/, extract.ts (heuristic recall), select.ts (judge selection)
src/topology/       store.ts (links, auto routing), lineage.ts (lineage tree explorer)
src/temporal/       bi-temporal.ts (non-destructive invalidations, asOf point-in-time)
src/security/       acl.ts (resource-level ACL rules, PermCov measurement)
src/collaboration/  live.ts (real-time active session search, subscriptions + delivery)
src/artifacts/      graph.ts (co-occurrence & multi-hop BFS graph traversal)
src/feedback/       store.ts (feedback loop + ranking bias)
src/eval/           metrics.ts (NDCG, MRR, ALCE), runner.ts (arms), beir.ts (BEIR corpora)
src/observability/  usage.ts (shape-only usage log), report.ts (opt-in aggregate telemetry)
src/discovery/      mdns.ts
src/git/            hooks.ts
src/transports/     http.ts (token auth, host/origin checks), mcp.ts (17 tools)
src/app.ts          shared singleton factory + write locks
src/commands.ts     transport-agnostic logic
src/setup.ts        onboarding primitives behind `init`
src/cli.ts          auto-delegating CLI
src/remote.ts       port file, probe, loop-guard federation client
src/remotes.ts      remotes.json (0600) + read-only fan-out
src/watch.ts        fs watcher for serve --watch
scripts/            run-eval.ts, sweep.ts, sweep-cell.ts, bench.ts, build-swe-gym.py, fetch-native-binding.py
sweeps/             sweep manifests (results.sqlite is git-ignored)
experiments/        parked custom-embedder training, paid-hosting note
launchd/            com.context-gateway.serve.plist
gateway.sh          nvm-resolving entrypoint
ui/                 SwiftUI MenuBarExtra native macOS app (GatewayMenuCore + App)
tests/              37 suites (235 tests) + 3 Swift XCTest tests
```

## Known limits

- Single user. Loopback by default; serving the network is opt-in and requires `GATEWAY_TOKEN`.
- No local models. Without `VOYAGE_API_KEY` search is lexical-only; without `TYPESAFE_API_KEY` there is no Jev reranking and `decide` returns heuristic candidates.
- Summaries are extractive (first lines), never LLM-generated.
- The `SessionEnd` hook installed by earlier versions of `init` used `node --import tsx`, which resolves tsx from the hook's working directory, so it only worked inside this repo. Re-run `init` (or `init --proactive`): it repairs the entry in place to go through `gateway.sh`.
- The action index reads Codex tool calls from their turns, which are capped at 4,000 characters, so a very long patch can lose its later file headers.
- The action index counts edits made through edit tools (`Edit`, `Write`, `apply_patch`). A file changed by a shell command (`sed -i`, a script, `cat >`) appears only as that command.
- Incremental sync keys on file mtime/size, so it cannot see a parser change on its own. Adapter output changes bump `PARSE_VERSION` (`src/adapters/types.ts`), and the next `sync` rebuilds the lexical index automatically. Vectors are kept: turns whose text changed keep their old embedding until you delete the vector store and `backfill` again.
- One `TantivyIndex` writer per index dir per process — the CLI delegates writes to a live `serve`; readers are unaffected.
- The Cursor adapter follows the documented 2026 format but has never been verified against a real Cursor history.
- `init` detects Claude Code and Codex histories only; the other adapters read their default locations or need their path configured.
- The Git adapter lists HEAD's last 50 commits for every branch session, so branch sessions other than the checked-out one repeat HEAD's log.
- `deriveFromTurns` (automatic supersession detection) is library-only: nothing runs it during sync, so invalidations come from `POST /temporal/invalidate`.
- Almost every tuned constant was measured on the synthetic fixture corpus; BEIR checks the retrieval side, but the embedding chunk size has not been re-tuned since the switch from BGE-small to Voyage.
- Parsed turns are cached per adapter (256 sessions / 200M chars, ~222 MB for the measured corpus).
- Zep sessions served by the REST API are re-indexed at most every 5 minutes (the API exposes no change stamp).

## License

Apache License 2.0; see [`LICENSE`](./LICENSE).
