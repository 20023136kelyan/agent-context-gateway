# Agent Context Gateway — Detailed MVP Plan (v2)

**Status: MVP + Phase 2 complete (2026-09-15). 52/52 suite green, live index
156 sessions / 99.5k docs serving on loopback via launchd.**

**Scope fix vs spec §61:** MVP is now **2 harnesses: Claude Code + Codex**.
1-harness MVP could never pass §78 acceptance (Codex Session A → Claude Session B query).

**Locked stack:**
- Language: TypeScript
- Lexical: **Tantivy via `@pngwasi/node-tantivy-binding@0.3.4`** (primary).
  Spike history: bare `tantivy@0.1.0` npm package is abandoned/broken
  (missing darwin-arm64 binary) — but the Rust engine is mature (v0.26.1,
  49 releases) and the pngwasi binding (v0.3.4, Mar 2026, prebuilt
  darwin-arm64) verified working: upsert, boolean filtered search, deletes,
  stored-doc retrieval. `SQLite FTS5 via node:sqlite` kept as tested fallback;
  both implement `SearchIndex` (`src/indexing/types.ts`).
  Real-data bench (154 sessions / 107k turns): Tantivy 1.7ms avg search vs
  SQLite 14ms; cold sync 41s vs 28s (per-session commits — batch later).
- Interfaces: CLI + HTTP + MCP (spec said MCP later — pulled into MVP per decision)
- Security: local-only, single-user (same UID, same machine, file-ownership = authz)

---

## 1. Grounded native sources (verified on this machine)

**Claude Code:**
- Path: `~/.claude/projects/<project-slug>/<sessionId>.jsonl`
- JSONL line types: `user`, `assistant`, `queue-operation`, `custom-title`, `ai-title`, `mode`
- Key fields: `uuid`, `parentUuid`, `timestamp`, `sessionId`, `cwd`, `gitBranch`,
  `version`, `isSidechain`, `message.content[]`, `entrypoint`
- Session ID = filename. Project = slug dir. No explicit parent/child — topology null for MVP.

**Codex:**
- Path: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`
  + `~/.codex/history.jsonl`, `session_index.jsonl`
- First line type `session_meta`: `session_id`, `cwd`, `originator`, `cli_version`, `model_provider`
- Session ID embedded in filename + `session_meta.payload.session_id`
- Parser must tolerate `session_meta`, response, user_message, tool_call variants —
  unknown types become opaque Turn with raw JSON preserved.

Both are JSONL, append-only → incremental index via `(file_path, mtime, byte_offset)` cursor.

---

## 2. Repo structure (MVP-trimmed, extensible to spec §60)

```text
agent-context-gateway/
  package.json (pnpm, ESM, node>=20)
  tsconfig.json (strict)
  src/
    core/models.ts
    core/id.ts
    adapters/types.ts
    adapters/claude.ts
    adapters/codex.ts
    adapters/registry.ts
    indexing/tantivy.ts
    indexing/store.ts
    search/query.ts
    search/rank.ts
    transports/http.ts
    transports/mcp.ts
    cli.ts
  tests/fixtures/claude/*.jsonl
  tests/fixtures/codex/*.jsonl
```

Defer to Phase 2: `federation/`, `authorization/`, `vector/`, `graph/`.

---

## 3. Canonical model (see `src/core/models.ts`)

- `Harness = "claude-code" | "codex"`
- `Agent`, `Session`, `Turn`, `Artifact`, `Provenance`, `SearchResult`
- ID rule: `turn.id = {harness}:{sessionId}:{uuid|ordinal}`. Never mutate native IDs.
- Provenance mandatory on every result — fail query if missing (spec §36).

## 4. Adapter contract (see `src/adapters/types.ts`)

- `listSessions()`, `listTurns(sessionId)`, `getTurn(sessionId, turnId)`, `getCursor()`
- `capabilities()` = `{ sessions: true, turns: true, search: false, topology: false }`
- `search()` is NOT per-adapter in MVP — global Tantivy index searches.
- Normalization: strip Claude `queue-operation`/`custom-title`/`mode`; keep
  `user`+`assistant`+tool I/O as Turn. Cap content at 8k chars/turn, keep raw
  pointer via byte offset for direct retrieval.
- `fileRefs` MVP: regex for cwd-relative paths + `PR #\d+` + `src/\S+`. No AST.

## 5. Tantivy index

Schema per Turn doc:

```text
id (stored, fast), harness (facet), sessionId (stored), projectId (facet),
workspace (facet), timestamp (fast, i64 ms), role (facet),
content (text, tokenizer: default + lower + stem), fileRefs (facet)
```

- Index dir: `~/.context-gateway/index-tantivy/` — disposable. `rebuild` = rm -rf + rescan.
- Incremental: compare mtime/size, resume from byte offset, append new turns.
- Direct retrieval bypasses Tantivy (read JSONL at offset) for freshness.

**Risk:** Tantivy Node bindings less mature than SQLite FTS5.
**Mitigation:** isolate behind `indexing/tantivy.ts` (`indexTurns()`, `search()`, `rebuild()`)
so swap to SQLite FTS5 costs <1 day. Time-box binding spike to 4h in M1.

## 6. Search (MVP lexical + filters)

Pipeline: normalize query → scope filter → Tantivy topK=50 → boost → expand → package.

- Normalization: lowercase, strip `?`, extract `PR #N`, `file:`, `before:/after:`
  (support `yesterday`, ISO). No LLM rewrite in MVP.
- Scope MVP: `project` (default, match cwd slug), `all_available`,
  `session:<id>`, `harness:<h>`. `parent/children/siblings/auto` → `not_supported_in_mvp`.
- Ranking: `0.7*tantivy + 0.15*project_match + 0.1*recency_decay(30d half-life)
  + 0.05*exact_entity_match`. Deterministic, explainable.
- Expansion: ±3 turns around hit (`maxTurns=7`, `maxTokens≈2000`). Dedupe overlaps.
- Packaging: compact = first-2-lines extract (no LLM) + evidence turns + provenance
  + sourcePath. No generated summaries (avoids §36 hallucination risk).
- Budgets: `maxResults=5, maxTurns=7, maxTokens=2000` as query params.

## 7. Transports (all three in MVP)

CLI:

```bash
gateway sources
gateway sessions --harness claude-code --project <slug>
gateway search "what did codex decide about collaboration?" --project <slug> --json
gateway session <harness> <sessionId>
gateway turn <harness> <sessionId> <turnId>
gateway sync [--rebuild]
```

HTTP (localhost `127.0.0.1` only):

```text
GET /sources, GET /sessions?harness=&project=
GET /search?q=&project=&harness=&maxResults=&maxTurns=
GET /sessions/:harness/:id, GET /sessions/:harness/:id/turns/:turnId
POST /sync, GET /health (index count, lastSync, per-harness counts)
```

MCP (thin wrappers over same core):

```text
context.list_sources, context.list_sessions, context.search,
context.get_session, context.get_turn, context.get_context
```

## 8. Security (local-only MVP)

- Bind HTTP to loopback only. No token (same-user implicit).
- Enforce sourcePath under `~/.claude/projects/` or `~/.codex/sessions/`; reject `..`.
- Log counts/latency, never content (spec §50).
- Multi-user / remote / ACL = Phase 2.

## 9. Milestones + tasks

- [x] **M0 Scaffold (0.5d):** TS repo, lint/test (vitest), models, id, adapter types,
      fixture sampling (5 Claude + 5 Codex sessions, redacted).
- [x] **M1 Adapters (2d):** Claude parser, Codex parser, registry. Tests: counts,
      stable IDs, timestamps, unknown lines don't crash. Tantivy binding spike.
- [x] **M2 Index (1.5d):** schema, full build, incremental sync, rebuild,
      corruption → auto-rebuild. Test: delete → rebuild → identical count.
- [x] **M3 Search (1.5d):** normalize, scope, rank, expand, package + provenance.
- [x] **M4 Transports (2d):** CLI, HTTP, MCP + health. Test: same turnId via all three.
- [x] **M5 Acceptance + hardening (1.5d):** §78 fixtures, 10-step checklist,
      perf <500ms on ~1k sessions, docs.
  - `tests/acceptance.test.ts` encodes all 10 §78 steps (Codex-A decision,
    Claude-B query, Monaco/lunch distractors, direct-retrieval equality,
    no-write-to-sources assertion). 24/24 suite green.
  - Perf: index.search 4–8ms; session scan cached to ~5ms; end-to-end
    ~0.7–1.2s worst-case on giant 3–5k-turn sessions (JSON parse floor),
    <300ms typical. Byte-range window reads noted as follow-up.
  - Fixes along the way: Codex `session_meta` >8KB truncation (read-until-newline,
    0 filename-fallback IDs across 85 sessions); stale index IDs after ID-scheme
    fix required `sync --rebuild` (documented in README).

Total ~9d solo, ~4-5d with parallel adapter work.

## 10. Updated acceptance (2-harness)

1. Two real histories present (Claude + Codex, same project slug).
2. `gateway sync` indexes both.
3. `search("What did Codex decide about collaboration?")` with project scope
   returns Codex Session A turns, not unrelated.
4. Result includes harness/agent/session/turn/timestamp/sourcePath.
5. `get_turn` reproduces exact native JSONL line.
6. Claude-history query also works (symmetry — proves cross-harness).
7. No manual memory write in either fixture.
8. Delete index → `sync --rebuild` → same results.
9. Unavailable source → `Source unavailable`, not fabricated.
10. Stale index → `lastSync` visible in health + search response.

---

## 11. Source of truth

Concept spec: `Agent Context Gateway — Project Specification.md` (§1-80).
This file is the build plan. On conflict, spec principles win (§73):
native history is truth, provenance always, least context, disposable index.

## 12. Roadmap: Phases A–F (agreed 2026-09-16)

Measurement before optimization; each phase gates on the eval harness.
See README status section for current position.

- **Phase A — Eval harness (gating).** `tests/eval/golden.json`: 24 queries
  with judged relevant session IDs, domain-stratified (code-dense Cozea +
  prose-heavy Adori/Shopify etc.), real session contents. Metrics: NDCG@5 +
  MRR for ranking; ALCE-style citation precision/recall for `decide`
  (evidence claims vs packaging text split). Baseline committed; no retrieval
  change lands without beating it.
- **Phase B — Retrieval precision, in order.** RRF fusion replacing the
  weighted sum → CAsT-style query rewriting (topology refs first, no model)
  → local ONNX cross-encoder rerank on fused top-K (p95 <300ms budget) →
  BFS traversal over the artifact graph (query-time, zero new state).
- **Phase C — Time and trust.** Derived invalidation markers (bi-temporal
  lite, re-derivable, no manual overrides) → per-source ACLs + PermCov tests
  (enforced at the packaging-time post-filter).
- **Phase D — Infra swaps.** MLX embeddings sidecar (replaces Ollama daemon;
  Ollama stays fallback; same paraphrase-ordering quality gate) →
  time-boxed storage-consolidation spike (LanceDB native FTS vs split;
  benchmark decides).
- **Phase E — Federation and judgment.** Zep adapter (read-only source) →
  Apple-FM judge + RAG-Fusion query variants (gated on FM availability +
  measured lift).
- **Phase F — Spec §65.** Live active-session search, lineage explorer,
  subscriptions/push, org-wide discovery.

**Deferred by decision:** code-specialized embeddings in core (domain
overfit); SPLADE (GPU cost, out-of-domain risk — revisit only if Phase A
shows lexical failing); manual memory-write UI of any kind.
