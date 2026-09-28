# Study: Graphify and Graphiti as the base for Bifröst

Sources: the source code of both projects, cloned on 28 Sep 2026.

| Project | Repository | Version studied | License |
|---|---|---|---|
| Graphify | `Graphify-Labs/graphify` (`graphifyy` on PyPI) | 0.9.70, commit `4c21b15` | Apache-2.0 |
| Graphiti | `getzep/graphiti` | 0.30.2, commit `6b4b56f` | Apache-2.0 |

Goals of the study:

1. how each tool is built, and where a new layer can attach;
2. how agents discover and use it;
3. how it stays up to date;
4. how the map can serve as Bifröst's spatial anchor;
5. how to serve Bifröst to agents usefully and cheaply.

---

## 0. Headline findings

1. **Only Graphify is a codebase map.** Graphiti is a temporal *memory* graph for agents: people, facts and episodes pulled out of text by an LLM. It has no parser and no notion of files, symbols or lines. In Bifröst's terms it resembles the **work store**, not the map. Section 3 covers what to take from it.
2. **Graphify already has the start of a work layer.** Its `graphify save-result` → `graphify reflect` loop records the outcome of each Q&A (`useful`, `dead_end`, `corrected`). It writes a sidecar, `.graphify_learning.json`, keyed by node ID and fingerprinted by file hash to flag stale entries, and merges it into query output at read time. This shows the overlay pattern works on this map. It also means Graphify is moving toward Bifröst's space; it is building a hosted, always-on product (graphify.com, YC S26).
3. **Graphify proves the delivery channel.** On Claude Code it installs `PreToolUse` hooks on `Read|Glob` and `Bash|Grep`. They call `graphify hook-guard`, which runs in about 170 ms warm with a 10 s timeout and returns `additionalContext`. Today that is a generic "use the graph" nudge. Bifröst would use the same hook to inject place-specific notes.
4. **Graphify node IDs make a poor primary anchor.** An ID is a normalized path plus symbol name (`src_auth_refresh_refreshsession`), so it changes on every rename or move. Nodes carry only a start line (`"L42"`), with no end line. Community IDs are renumbered on every clustering. This confirms the architecture's choice of repository-native anchors, with the map node ID kept as a resolved, cached secondary key.

---

## 1. Graphify

### 1.1 How it is built

A Claude Code skill drives a Python library. The pipeline, from `ARCHITECTURE.md`:

```text
detect() → extract() → build() → cluster() → analyze helpers → report.generate() → export.to_*()
```

| Stage | What it does |
|---|---|
| `detect` | Scans the directory. Respects `.gitignore` and `.graphifyignore`. Groups files by category. |
| `extract` | **Code:** tree-sitter across 37 grammars. Deterministic, no LLM, nothing leaves the machine. **Docs, PDFs, images, video:** an LLM semantic pass. |
| `build` | Merges extractions into a NetworkX graph and normalizes IDs (`graphify/ids.py`). |
| `cluster` | Leiden community detection. The graph itself is not changed. |
| `analyze` | God nodes, surprising connections, import cycles, graph diff. |
| `export` | `graph.json`, `graph.html`, Obsidian, SVG, GraphML, Cypher; push to Neo4j or FalkorDB. |

Everything lands in `graphify-out/`:

- `graph.json`: the map, in node-link JSON;
- `GRAPH_REPORT.md`;
- `graph.html`;
- `manifest.json`: per-file hashes, portable and safe to commit;
- `cache/`: the AST cache;
- sidecars such as `.graphify_learning.json`.

**Node shape**, from a real `graph.json`:

```json
{ "id": "analyze_node_community_map", "label": "_node_community_map()",
  "file_type": "code", "source_file": "worked/mixed-corpus/raw/analyze.py",
  "source_location": "L6", "community": 3 }
```

**Edge shape:**

```json
{ "source": "analyze", "target": "analyze_node_community_map", "relation": "contains",
  "confidence": "EXTRACTED", "confidence_score": 1.0,
  "source_file": "…/analyze.py", "source_location": "L6", "weight": 1.0 }
```

- Relations include `contains`, `calls`, `imports`, `uses`, `inherits`, `method`, `references` and `depends_on`.
- `confidence` is one of `EXTRACTED`, `INFERRED` or `AMBIGUOUS`.
- The top level also has `hyperedges` and `built_at_commit`.
- Nodes and links are sorted and keys are ordered canonically, so two equivalent builds produce identical bytes.

**Identity rules** (`graphify/ids.py`, `extractors/base.py`):

- The ID is `make_id(file_stem, symbol)`. The input is casefolded, NFKC-normalized, and every run of non-word characters becomes `_`.
- `file_stem` keeps the full repo-relative path without its extension. `docs/v1/api/README.md` becomes `docs_v1_api_readme`.
- **Consequence:** renaming a file or symbol creates a new node. The old node disappears on the next update. Nothing records that the two are the same thing.
- Rationale comments (`# NOTE:`, `# WHY:`, `# HACK:`) and ADR or RFC references become their own nodes, linked to the code they explain. This is the closest thing Graphify has to notes today, but they live in the source.

**Where extensions attach today:**

| Extension point | Use for Bifröst |
|---|---|
| Reading `graph.json` directly | The simplest and most stable coupling. The format is plain, sorted and deterministic. |
| Sidecar files next to `graph.json` | Graphify's own overlay pattern. It currently loads only its own `.graphify_learning.json`. |
| The MCP server (`graphify.serve`) | Bifröst can sit beside it or wrap it; see §4.3. |
| Upstream PR | A general "overlay provider" hook in `_subgraph_to_text` and `get_node`. Not present today. |

Do **not** write into `graph.json`:

- it is regenerated on every update;
- a shrink guard refuses to write a graph with fewer nodes;
- its merge driver rewrites the file as a union of both sides;
- the learning layer itself keeps its fields out of it by design (reflect.py: "no learning_* fields are ever stamped into the graph itself").

### 1.2 How agents discover and use it

There are four mechanisms, layered:

1. **Skill:** `graphify install` writes `SKILL.md` for 20+ platforms, and the user types `/graphify .`.
2. **Always-on instructions:** a block in `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, or `.cursor/rules/graphify.mdc` (with `alwaysApply: true`). It tells the agent to run `graphify query "<question>"` before grepping, and `graphify update .` after editing.
3. **Hooks,** which do the real steering:
   - **Claude Code:** `PreToolUse` with matcher `Bash|Grep` calls `hook-guard search`, and matcher `Read|Glob` calls `hook-guard read`. The guard reads the tool-call JSON on stdin. It fires only for in-project source files when a fresh graph exists, and prints an `additionalContext` nudge. It always exits 0, so it fails open.
   - **Strict mode** (`--strict`) *denies* the first raw read per session through `permissionDecision`, then falls back to the nudge.
   - **Codex:** a hook is registered but deliberately does nothing. Codex Desktop rejects `additionalContext` on `PreToolUse`, so `AGENTS.md` is the only always-on channel there.
   - **Gemini CLI:** a `BeforeTool` hook that always allows the call and appends the nudge.
4. **MCP server:** `python -m graphify.serve graph.json`, over stdio or streamable HTTP at `/mcp`, with an API key for shared use.
   - Tools: `query_graph` (BFS or DFS, depth, `token_budget`), `get_node`, `get_neighbors`, `get_community`, `god_nodes`, `graph_stats`, `shortest_path`, and PR tools (`list_prs`, `get_pr_impact`, `triage_prs`).
   - Resources: `graphify://report`, `graphify://god-nodes`, `graphify://surprises`, and more.
   - Output is plain text lines (`NODE <label> [src=… loc=… community=…]`). Each call is cut to its token budget at about 3 characters per token, with seed nodes ranked first and the rest by hop distance.

Discovery is therefore **query-driven**. The agent has to ask, and the hooks only push it toward asking. No content arrives on its own, which is exactly the gap Bifröst fills.

### 1.3 How it updates

| Trigger | Behavior |
|---|---|
| `git commit` | Post-commit hook: a detached background rebuild, AST only, no API cost. It pins the interpreter path at install. |
| `git checkout` / `switch` | Post-checkout hook: the same rebuild. |
| `git pull` / `merge` | Manual `graphify update .` (the README suggests a `gpull` alias). |
| File changes | `graphify watch` with a 3 s debounce. |
| Docs or media changed | `/graphify --update` reruns the LLM pass on changed files only. |

Mechanics:

- Incremental rebuild takes the changed paths, re-extracts only those files, and keeps the other nodes. Paths that no longer exist on disk are dropped.
- A rebuild lock plus a `.pending_changes` queue prevents concurrent hooks from losing changes.
- Rebuilds are atomic writes, with a shrink guard.
- A git merge driver unions `graph.json` so it never shows conflict markers.
- The MCP server **hot-reloads** `graph.json` when its mtime or size changes, inside the tool handlers.

**Implication for Bifröst:** the map is at best "as of the last commit", or seconds behind with `watch`. Edits an agent hasn't committed yet are not in it. Place resolution must work from the file path first and use the map to enrich, not to gate.

### 1.4 Graphify's existing work-memory overlay

- `save-result` writes Q&A memory docs to `graphify-out/memory/`, with frontmatter: `question`, `outcome ∈ {useful, dead_end, corrected}`, `correction`, `source_nodes`.
- `reflect` scores each cited node deterministically: signed, time-decayed with a 30-day half-life, and promoted only after two corroborating results. It writes `reflections/LESSONS.md` plus the sidecar:
  ```json
  { "version": 1, "generated_at": "…",
    "nodes": { "<node id>": { "status": "preferred|tentative|contested", "score": 0.0, "uses": 0, "last": "…",
                "label": "…", "source_file": "…", "code_fingerprint": "<file hash>", "provenance": [ … ] } } }
  ```
- At load, each entry is marked `stale` if its source file's hash changed. Query output then gets `learning=preferred:stale` on that node.

**Compared with Bifröst:**

| | Graphify overlay | Bifröst |
|---|---|---|
| What is recorded | Whether a node was useful for a question | Typed findings, tasks, presence, activity |
| Who writes | One user's Q&A loop | Every agent, across Claude Code, Codex and Cursor |
| Delivery | Only inside results the agent asked for | Pushed at the place, or silence |
| Staleness | Whole-file hash, so any edit to the file flags it | Should be per symbol span (§4.2) |
| Live state | None | Presence, and "who is here now" |

The pattern (sidecar keyed by node, fingerprint for staleness, merged at display time) is worth copying. Its granularity and scope are what Bifröst improves on.

---

## 2. Graphiti

### 2.1 What it is

"A framework for building temporal context graphs for AI agents." It is the open-source core of Zep. Its data comes from **episodes**: messages, text or JSON ingested over time. An LLM extracts entities and facts from them.

| Element | Fields that matter |
|---|---|
| `EpisodicNode` | `content` (raw data), `source`, `valid_at`, `entity_edges`: the provenance |
| `EntityNode` | `name`, `summary` (evolves), `attributes`, `name_embedding`, `labels` (custom types) |
| `EntityEdge` (a fact) | `fact` text, `valid_at`, `invalid_at`, `expired_at`, `reference_time`, `episodes[]`, `fact_embedding` |
| `CommunityNode`, `SagaNode` | Cluster summaries; ordered chains of episodes |
| `group_id` | A partition key on every node and edge, such as a tenant, project or user |

- **Storage:** bring your own graph database: Neo4j, FalkorDB (the MCP default), Kuzu or Neptune.
- **Models:** an LLM (OpenAI, Anthropic, Gemini, Groq, Azure) and an embedder (OpenAI, Voyage, Gemini).
- **Extension:** custom Pydantic entity and edge types, and custom extraction instructions.

### 2.2 How it is built and updated

`add_episode()`:

1. extract entities with the LLM;
2. resolve and deduplicate them against the existing graph;
3. extract facts;
4. resolve them against existing facts: a contradicted fact gets `invalid_at` and `expired_at` set, and is never deleted;
5. extract timestamps;
6. embed;
7. save.

There are about 13 LLM call sites in the maintenance code. A single write costs several model calls and takes seconds. `add_episode_bulk` batches writes, and the MCP server queues them asynchronously.

`add_triplet()` inserts a structured fact directly. It skips extraction but still needs embeddings and entity resolution.

Updates are **continuous and incremental**, one episode at a time, with no full rebuild. There is no file watching or git awareness, because nothing ties it to code.

### 2.3 How agents use it

Only through the **MCP server** (`mcp_server/`, HTTP at `/mcp/` or stdio):

- `add_memory`
- `search_nodes`
- `search_memory_facts`
- `get_episodes`
- `get_entity_edge`
- `get_episode_entities`
- `add_triplet`
- `delete_entity_edge`
- `delete_episode`
- `build_communities`
- `summarize_saga`
- `clear_graph`
- `get_status`

There are no hooks and no always-on instructions. Discovery depends entirely on the agent choosing to call a tool from its description.

Search is hybrid: cosine plus BM25 plus BFS, with RRF, MMR, cross-encoder, `node_distance` or `episode_mentions` reranking. `SearchFilters` can filter by node labels, edge types, `valid_at`/`invalid_at`/`created_at`/`expired_at` ranges, and properties. `center_node_uuid` reranks results by graph proximity to a node, which is the closest thing Graphiti has to "near this place".

### 2.4 What Bifröst should take from it

- **Not the anchor.** It has no code structure. A Graphiti "code map" would have to be built with `add_triplet` from another parser. In practice that means Graphify's own Neo4j or FalkorDB push, sharing the database with Graphiti.
- **Its temporal fact model is the right shape for findings.** `valid_at`, `invalid_at` and `expired_at`, each with provenance episodes, match the architecture's `validFrom`, `validUntil` and `supersededBy`, and our `src/temporal/` already implements something close. Adopt the semantics, not the dependency.
- **Not as the MVP store.** A graph database server plus LLM calls on every write works against local-first and cheap operation, and against the experiment's need for hand-written notes.
- **As an integration later.** Teams already on Zep or Graphiti could have Bifröst findings exported as episodes, or triplets with a `group_id` per repository. `src/adapters/zep.ts` already reads Zep threads.
- **As a competitive read.** Zep positions itself as "context infrastructure for agents". It does not do place-based delivery on a code map, which remains Bifröst's distinct angle.

If a second *code* map is wanted for comparison, the stronger candidates are symbol indexes with stable IDs: SCIP and LSP-based indexes. Their symbol identities survive better than Graphify's path-derived IDs, and would make a useful fallback anchor source.

---

## 3. Side by side

| | Graphify | Graphiti |
|---|---|---|
| Models | Code structure, plus docs and media | Facts about entities, over time |
| Built by | tree-sitter (deterministic); LLM only for non-code | LLM extraction on every write |
| Storage | `graph.json` files; optional Neo4j or FalkorDB push | A graph database server (required) |
| Identity | Normalized path and symbol name | UUIDs with LLM entity resolution |
| Time | `built_at_commit` snapshot | Validity windows on every fact |
| Update | Git hooks, watch, incremental AST | Continuous, one episode at a time |
| Agent discovery | Skill, always-on instructions, PreToolUse hooks, MCP | MCP only |
| Output to the agent | Token-budgeted text subgraph | JSON facts and nodes |
| Role for Bifröst | **The spatial anchor** | **A model for the temporal store**; an optional sync target |

---

## 4. Design implications for Bifröst

### 4.1 The anchor

Store anchors in repository terms and resolve them against the map:

```text
Anchor (stored)                         Map binding (derived, cached)
  repository                              mapTool: "graphify"
  path            ─── resolve ──►         nodeId: "src_auth_refresh_refreshsession"
  symbol?                                 builtAtCommit: "…"
  lineStart?, lineEnd?                    neighbors: [...]   (for nearby notes)
  commit                                  area: community label (display only)
  spanFingerprint                         
```

- **Path to nodes:** every node whose `source_file` equals the path. The file node is the one with the `contains` edges.
- **Line to symbol:** Graphify gives only start lines. Take each symbol's range as running from its `source_location` to the next sibling's start within the same file. This also fills in `lineEnd` for anchors.
- **Symbol to node:** by label within the file (`refreshSession()`); if that is ambiguous, use the nearest start line.
- **Nearby notes:** follow `calls`, `imports`, `inherits` and `uses` one hop out, weighting by hop. Surface a note from a neighbor only when the direct place has nothing. `EXTRACTED` edges outweigh `INFERRED` ones; `AMBIGUOUS` edges are ignored.
- **Areas:** use communities to orient an agent at session start ("most activity this week is in the auth and session area"). Never anchor to a community ID, because it is renumbered on every build.

### 4.2 Keeping anchors valid as the map changes

- **Staleness:** fingerprint the anchored **symbol span**, not the whole file, as Graphify does. Otherwise any edit anywhere in a file marks every note on it stale. When the span hash changes, show the note as "code changed since", and don't hide it.
- **Renames and moves:** at update time, run `git diff -M --name-status <old>..<new>` to carry path anchors across. If a symbol's node ID disappears, try the same label in the same file, then the same label anywhere in the same community. Otherwise leave it as an orphan note visible only through `where(topic)`.
- **Follow Graphify's clock:** watch `graphify-out/graph.json` (mtime and size, like `graphify.serve`) and rebuild the binding cache when it changes. Read `built_at_commit` to know how old the map is.
- **Work without the map:** if there is no `graph.json` or it is stale for this file, resolve by path and line only. Bifröst must never require the map to deliver a note.

### 4.3 Serving

The order below is from cheapest and most effective to least.

1. **File-touch hook (the primary channel).**
   - Claude Code: `PreToolUse` on `Read|Edit|Write|Grep` and `SessionStart`. Gemini: `BeforeTool`.
   - The hook asks a **long-running local Bifröst daemon** (Unix socket or localhost). Spawning an interpreter per call, as Graphify's guard does, costs about 170 ms; the daemon's target is under 50 ms.
   - It returns `additionalContext` with 2–3 lines and at most 150 tokens, or nothing.
   - It is never allowed to block. It never uses `permissionDecision`, and it fails open like Graphify's guard.
   - A `PostToolUse` hook on edits records activity and presence.
2. **Session start.** A short orientation of about 100 tokens: live agents and their places, failing or unverified tasks, and fresh warnings, grouped by community label.
3. **Enriched map answers.** Offer a Bifröst MCP server with `at(place)`, `where(topic)`, `note(...)` and `vote(...)`. Optionally, run it as a thin proxy in front of `graphify.serve`, which appends Bifröst lines to `get_node`, `get_neighbors` and `query_graph` results inside the same token budget. Graphify reloads per call and returns plain text, so a proxy is simple. Later, propose an upstream "overlay provider" hook so no proxy is needed.
4. **Platforms without context injection.** Codex rejects `additionalContext` on `PreToolUse`. Cursor has only rules and MCP. For these, use an always-on block in `AGENTS.md` or `.cursor/rules`, phrased as "before editing a file, call `bifrost.at(path)`", plus MCP. This is weaker and should be measured separately in the experiment.

**Output format.** Match Graphify's line style so the two read as one map:

```text
BIFRÖST src/auth/refresh.ts#refreshSession
  WARNING 2d · codex · ✓2  Retrying inside refreshSession() loops on 401s; the obvious fix was reverted in a1b2c3d. → thread 7f3
  TASK    failing · claude-code (live, 4m)  Token rotation under concurrent refresh
```

**What counts as "new".** Keep a per-session set of items already shown. Show an item again only if it changed, or the code under it changed, since this session last saw it.

**Order of what is shown:**

1. direct anchor before neighbor;
2. `warning` and `known-issue` before `decision` before the rest;
3. live presence;
4. recency.

Then cut to the token budget, the same way Graphify's `_subgraph_to_text` does.

**Coexisting with Graphify's own hook.** Both fire on `Read`. Graphify's says "use the graph"; Bifröst's says "here is what happened here". They don't conflict. Tell users not to combine Bifröst with Graphify's `--strict` mode, because a denied first read also hides Bifröst's note for that read.

---

## 5. Next steps

1. **Prototype the resolver on real data.** Run Graphify on this repository, then write a small `resolve(path, line) → {nodeId, symbol, span, neighbors}` against the `graph.json` it produces. Measure how often it resolves cleanly, and how anchors survive a rename commit.
2. **Measure the hook path.** A Claude Code `PreToolUse` hook calling a stub daemon: check real latency and how `additionalContext` shows up in the transcript.
3. **Use Graphify in the upper-bound experiment.** Hand-written findings anchored with the scheme above, delivered through the hook, on a repo Graphify has mapped.
4. **Talk to Graphify upstream** about a general overlay-provider interface, since their learning overlay shows they are open to the pattern. Note the competitive risk: their hosted always-on product may grow in this direction.
5. **Defer Graphiti** to an export adapter after the experiment. Adopt its fact-validity semantics in the finding schema now.
