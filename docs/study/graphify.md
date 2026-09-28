# Graphify in depth

Version 0.9.70 (`Graphify-Labs/graphify`, commit `4c21b15`, Apache-2.0), studied from source and by running it on this repository. All measurements are from a copy of the `work-layer` branch in a Linux container with 4 cores. The probe scripts are in [`probes/`](./probes/).

Contents:

1. What it is
2. Construction: the pipeline
3. The graph format
4. Identity: how nodes are named
5. Extraction quality on this repository
6. Communities
7. How agents discover and use it
8. Querying and serving
9. Updating
10. The work-memory overlay
11. Other surfaces
12. Measurements
13. Consequences for Bifröst

---

## 1. What it is

A Python library (`graphifyy` on PyPI, ~78k lines) plus an agent skill that drives it. It turns a folder into a knowledge graph and writes it to `graphify-out/`.

- **Code** is parsed with tree-sitter: deterministic, local, and free.
- **Docs, PDFs, images and transcripts** go through an LLM pass run by parallel subagents of the user's own assistant, or by a configured API backend.
- The company behind it (YC S26) is building a hosted, always-on version at graphify.com.

---

## 2. Construction: the pipeline

```text
detect() → extract() → build() → cluster() → analyze helpers → report.generate() → export.to_*()
```

Each stage passes plain dicts and a NetworkX graph to the next.

### detect (`detect.py`)

- Walks the target and sorts files into categories: code, document, paper, image, video.
- Respects `.gitignore` per directory, merged with `.graphifyignore`, which wins on conflicts.
- Files it can't classify are listed and skipped. On this repo that was `.env.example`, `.gitignore`, the launchd plist and a `.jsonl` fixture.

### extract, code side (`extract.py`, `extractors/engine.py`, `extractors/resolution.py`, `symbol_resolution.py`)

- 37 tree-sitter grammars, with a `LanguageConfig` per language. Extraction runs in a `ProcessPoolExecutor`, one process per core.
- **Per-file pass:** emits a file node plus a node for each class, function, method, interface, type alias, enum and most module-level constants.
  - Methods get the label `.name()` and hang off their class through `method` edges.
  - The file node reaches its top-level symbols through `contains` edges.
  - Import statements produce `imports` and `imports_from` edges.
  - Package manifests (`package.json`, `pyproject.toml`, `go.mod`) produce one `concept` node per dependency, such as `ref_commander`.
- **Rationale comments** (`# NOTE:`, `# WHY:`, `# HACK:`, module docstrings) become `rationale` nodes linked by `rationale_for` edges.
- **Resolution pass:**
  - Import targets resolve through the TS/JS module rules: `.js` → `.ts`, index files, `tsconfig` path aliases and `baseUrl`, workspace packages, and `package.json` `imports`.
  - Calls resolve to the imported symbol. When a call can only be matched by name, it becomes an `INFERRED` `calls` edge with score 0.8.
- **Edge context:** every edge records where it was seen, as the `context` field: `import`, `call`, `field`, `parameter_type`, `generic_arg`, `return_type`, `type`, `argument`, `export`. Queries can filter on it.

### extract, semantic side (the skill, `llm.py`)

- Only non-code files are sent. The skill runs "Pass 3" with parallel subagents of about 20–25 files each, which the skill makes mandatory.
- Each subagent gets `references/extraction-spec.md` and returns a JSON fragment of nodes, edges and hyperedges, with `INFERRED` confidence on a fixed scale (0.95, 0.85, 0.75, 0.65, 0.55).
- Results are cached by file hash and by prompt version, so a changed prompt re-extracts.
- Headless mode (`graphify extract`) calls a configured backend instead: Claude, OpenAI-compatible, Gemini, Ollama and others.
- **Markdown** gets a structural pass with no LLM (headings become `node_kind: heading` document nodes) whenever `update` runs. On this repo `update` added 239 heading nodes from 9 Markdown files.

### build (`build.py`, `dedup.py`, `ids.py`)

- Merges extraction fragments into one graph, re-normalizing every ID through `ids.normalize_id` so the AST and LLM producers agree.
- Mints stub nodes for external references (`ref_node_fs`, `external: true`).
- Fuzzy entity dedup, for semantic nodes: exact normalization → entropy gate → MinHash/LSH blocking → Jaro-Winkler check → same-community boost → union-find merge.
- **ID collisions:** when two files mint the same ID, one node is kept and the other dropped, with a warning. On this repo, Swift `import AppKit`, `import SwiftUI` and `import Foundation` collided across files, and 8 nodes were dropped.

### cluster (`cluster.py`)

- Leiden (native `graspologic` backend when installed), falling back to networkx Louvain.
- Communities larger than 25% of the graph get a second Leiden pass.
- Optional hub exclusion by degree percentile.
- IDs are ordered by size (0 = largest), then `remap_communities_to_previous` matches them greedily to the previous build by overlap. Section 6 covers what this does and doesn't stabilize.
- Communities are labelled by their hub node, with no LLM, unless `graphify label` is run with a backend.

### analyze and report

- `god_nodes` (highest degree), `surprising_connections` (cross-community edges ranked by how unexpected they are), `find_import_cycles`, `graph_diff`, `suggest_questions`.
- `GRAPH_REPORT.md` is the human summary.

### export

- `graph.json`: the canonical output.
- `graph.html` (vis.js), Obsidian vault, SVG, GraphML, Canvas, Cypher, a wiki (one article per community), and a D3 tree.
- Direct push to **Neo4j or FalkorDB**, the same databases Graphiti uses.

---

## 3. The graph format

`graphify-out/graph.json` is NetworkX node-link JSON:

```json
{ "directed": false, "multigraph": false, "graph": {},
  "nodes": [ … ], "links": [ … ], "hyperedges": [ … ],
  "built_at_commit": "f7c3c75…" }
```

**Node fields** as they appeared on this repository, with how many of the 1,144 nodes carry each:

| Field | Count | Meaning |
|---|---|---|
| `id` | 1144 | Canonical ID (§4) |
| `label` | 1144 | Display name: `SearchService`, `.search()`, `search.ts` |
| `file_type` | 1144 | `code`, `concept`, `rationale`, `document`, `paper`, `image` |
| `source_file` | 1144 | Repo-relative path; empty for external stubs |
| `source_location` | 1103 | **Start line only**, as `"L104"`. No end line and no column. |
| `community` | 1144 | Integer community ID; `community_name` once labelled |
| `norm_label` | 1144 | Label lowercased with diacritics stripped, for matching |
| `_origin` | 1114 | `ast` or semantic |
| `_callable`, `_callable_class` | 742, 168 | Whether the node is a function or method, or a class |
| `external`, `type`, `metadata`, `confidence` | few | Stubs and special nodes |

**Edge fields:** `source`, `target`, `relation`, `confidence`, `confidence_score`, `source_file`, and `source_location` (the line where the relation appears, e.g. the call site). Also `weight`, `context`, and sometimes `type_only` or `deferred`.

Edge relations on this repository (3,223 edges):

| Relation | Count | | Relation | Count |
|---|---|---|---|---|
| `imports` | 735 | | `dynamic_import` | 35 |
| `contains` | 655 | | `implements` | 31 |
| `calls` | 632 | | `rationale_for` | 9 |
| `imports_from` | 626 | | `re_exports` | 6 |
| `method` | 252 | | `indirect_call` | 5 |
| `references` | 232 | | `inherits` | 4 |

99% of edges are `EXTRACTED`. Only 39 `calls` edges and 5 `indirect_call` edges are `INFERRED`, for example `createApp() → .attachTopology()` at score 0.8.

Other files in `graphify-out/`:

| File | Purpose | Commit it? |
|---|---|---|
| `manifest.json` | Per-file content hashes, repo-relative | Yes; lets teammates update incrementally |
| `GRAPH_REPORT.md` | Summary | Optional |
| `cache/` | AST and semantic caches, hook session markers, query stamp | No |
| `.graphify_root`, `.graphify_python` | Absolute paths on this machine | No |
| `.graphify_analysis.json`, `.graphify_labels.json` | Communities, cohesion, labels | No |
| `memory/`, `reflections/`, `.graphify_learning.json` | The work-memory loop (§10) | Team choice |
| `needs_update`, `.pending_changes` | Update coordination (§9) | No |

Safety properties of the writer:

- **Sorted and canonical:** node and link keys are ordered, and lists are sorted by their JSON. Two equivalent builds produce identical bytes.
- **Shrink guard:** it refuses to write a graph with fewer nodes than the existing one unless forced. An unreadable existing file also refuses.
- **Atomic write.**
- **Git merge driver** that unions both sides of `graph.json`.

---

## 4. Identity: how nodes are named

`ids.make_id(file_stem, symbol)`:

1. `file_stem` is the repo-relative path without its extension, with every segment kept: `src/search/search.ts` → `src/search/search`.
2. It is joined to the symbol path with `_`: class, then method.
3. The result is casefolded and NFKC-normalized to a fixed point. Runs of non-word characters collapse to a single `_`.

Examples from this repository:

| Code | Node ID |
|---|---|
| `src/search/search.ts` (file) | `src_search_search` |
| `class SearchService` | `src_search_search_searchservice` |
| `SearchService.search()` | `src_search_search_searchservice_search` |
| `const RERANK_POOL` | `src_search_search_rerank_pool` |
| a dependency in `package.json` | `ref_commander` |

**Tested behaviour:**

| Change | Effect on IDs |
|---|---|
| 5 lines inserted at the top of `rank.ts` | IDs unchanged; `source_location` updated on the 12 nodes in the file |
| `git mv src/search/rank.ts src/search/ranking.ts` | **All 13 nodes in the file got new IDs**; 34 edges replaced. Nothing links old to new. |
| Rename `rrfBaseScore` → `rrfScore` | 1 node replaced, 6 edges replaced |

IDs are stable under edits and line shifts. They are **not** stable under file moves or renames, which are common in agent work. The label and line survive a file move, so a re-anchoring heuristic can pair old and new nodes: same label, same line offset within the file, and the same set of neighbour labels.

Also note:

- Case and punctuation are lost: `Foo_Bar` and `foo.bar` normalize to the same thing.
- Overloads and same-named symbols in one file share an ID.

---

## 5. Extraction quality on this repository

141 code files: TypeScript, Python, Swift and shell.

- **Coverage of top-level TypeScript declarations**, compared against a line scan:

  | Kind | Captured |
  |---|---|
  | Functions | 250 / 250 |
  | Classes | 25 / 25 |
  | Type aliases | 22 / 22 |
  | Interfaces | 98 / 99 |
  | Consts | 89 / 128 |

  Arrow functions assigned to consts (`export const embedDocuments = (…) =>`) are captured as callables. Local variables are never nodes, which is correct for a map.
- **Cross-file call resolution** is good. `SearchService.search()` links to `rewriteConversationalQuery`, `normalizeQuery`, `routeAutoScope`, `embedQueryResolved`, `rrfBaseScore` and `finalScore` in other files, each with the call-site line.
- **Interface dispatch** is where resolution guesses: `this.index.search(…)` becomes an `INFERRED` call to `SearchIndex.search`.
- **Blind spots:**
  - dynamic dispatch through maps of handlers;
  - string-keyed calls;
  - anything decided at runtime;
  - shell scripts beyond simple function definitions.

---

## 6. Communities

Communities are Graphify's notion of an "area". They are fragile:

| Change | Nodes whose community ID changed |
|---|---|
| Line shift in one file, plus Markdown headings added by `update` | 363 of 1,144 |
| **One new 1-line function in `src/core/lru.ts`** | **263 of 1,383** |

Remapping by overlap stabilizes the numbers, but membership itself moves. After the one-function change:

- the mean Jaccard overlap of each node's community before and after was 0.70;
- 436 of 1,383 nodes ended up in a community that shares less than half its members with their previous one;
- the community count went from 82 to 76.

Methods of one class are often split across communities. `SearchService`'s methods sat in communities 1, 4, 9, 31, 32 and 43.

Communities are useful for a snapshot view ("what are the subsystems today"). They are unusable as an anchor, and weak as a stable "area" label unless smoothed over time.

---

## 7. How agents discover and use it

Graphify layers five mechanisms, from weakest to strongest.

**1. Skill** (`graphify install`)

- Writes `SKILL.md` and a `references/` folder into the platform's skills directory for 20+ assistants.
- The skill's description claims any codebase question when `graphify-out/` exists.
- Its fast path tells the agent to go straight to `graphify query` when a graph exists.
- For builds it is a 719-line runbook: interpreter detection, detect, AST pass, *mandatory* parallel subagents for docs, merge, build, label, export, manifest, and cost tracking.

**2. Always-on instructions** (`graphify <platform> install`)

- A `## graphify` section in `CLAUDE.md`, `AGENTS.md` or `GEMINI.md`, a Kiro steering file, VS Code instructions, or `.cursor/rules/graphify.mdc` with `alwaysApply: true`.
- Four rules: query before grepping, use `path`/`explain`, read the report only for broad reviews, run `graphify update .` after editing.

**3. Hooks (Claude Code, CodeBuddy, Gemini)**

- `PreToolUse` matcher `Bash|Grep` → `graphify hook-guard search`; matcher `Read|Glob` → `graphify hook-guard read`. Each has a 10 s timeout.
- The guard reads the tool call from stdin and checks:
  1. the target is an in-project source file;
  2. a graph exists;
  3. whether the file is newer than `graph.json` (a stale graph softens the message).
- It prints one of three fixed `additionalContext` texts:
  - **read:** "MANDATORY: graphify-out/graph.json exists. You MUST run graphify before reading source files. Use: `graphify query …` … This rule applies to subagents too …"
  - **search:** "MANDATORY: … You MUST run `graphify query "<question>"` before grepping raw files …"
  - **stale:** "graph.json exists but may be STALE for this file … Reading the file directly is fine."
- **Measured cost here: 65 ms per call.** The guard imports lazily. The docs quote about 170 ms warm on other machines.
- The text is **the same on every read**. It carries no information about the file being read.
- **Strict mode** (`--strict` or `GRAPHIFY_HOOK_STRICT=1`) returns `permissionDecision: deny` on the first raw `Read` of an indexed file per `session_id`. It then falls back to the nudge. It stays silent while a query stamp from the last 30 minutes exists.
- **Codex:** a hook is registered, but `hook-check` is a no-op, because Codex Desktop rejects `additionalContext` on `PreToolUse`. `AGENTS.md` carries the guidance there.
- **Gemini:** `BeforeTool` always returns `{"decision":"allow"}` plus the nudge.
- **Kilo:** a `tool.execute.before` plugin.

**4. CLI**

- `query`, `path`, `explain`, `affected` (reverse traversal: who depends on X), `god-nodes`, `tree`, `prs`, `save-result`, `reflect`, `update`, `watch`, `global …`.

**5. MCP server** (`python -m graphify.serve graph.json`, stdio or streamable HTTP)

- Tools: `query_graph`, `get_node`, `get_neighbors`, `get_community`, `god_nodes`, `graph_stats`, `shortest_path`, `list_prs`, `get_pr_impact`, `triage_prs`.
- Resources: `graphify://report`, `stats`, `god-nodes`, `surprises`, `audit`, `questions`.
- HTTP mode supports `--api-key`, `--stateless` and session reaping, so one server can serve a team.

**Query vocabulary.** The skill makes the agent do "constrained query expansion" before each query:

1. dump the graph's label vocabulary;
2. pick up to 12 tokens from it that match the intent;
3. print the chosen tokens for audit.

This compensates for the matcher (§8).

**Summary:** the agent must *ask*. The hooks raise the odds that it asks, but never hand it anything specific to the place it is working.

---

## 8. Querying and serving

### Seed selection (`serve._score_query`, `_pick_seeds`)

- Case-folded substring and IDF over labels and search text, with a trigram index to generate candidates.
- **No stemming, no synonyms.** On this repo:
  - `"how does reranking work"` returned **no nodes**;
  - `"rerank"` and `"reranker"` matched;
  - `"token refresh"` pulled in `tokenMatches()` and the Swift `.refreshHealth()`, because of shared substrings.
- `get_node` resolves a label, an ID, a path (`src/search/search.ts` → the file node), or `path::symbol`.

### Traversal

- BFS (default, depth 3 over MCP, depth 2 from the CLI) or DFS, optionally filtered by edge `context`.
- Hubs flood results. `"temporal invalidation"` found 628 nodes at depth 3, most of them reached through `commands.ts`, `app.ts` and `search.ts`.

### Rendering (`_subgraph_to_text`)

- One line per node: `NODE <label> [src=… loc=… community=… learning=…]`, then edges.
- Cut to `token_budget` at about 3 characters per token.
- Seed nodes first, the rest by hop distance and then degree.
- A `[!] TRUNCATED: showing 12 of 18 nodes` header tells the agent how much was cut.
- Every string passes through `sanitize_label`, which strips control characters and caps length, to reduce prompt injection from corpus content.

### Latency (MCP over stdio, graph of about 1,400 nodes)

| Operation | Time |
|---|---|
| Server start (`initialize`) | 0.9 s |
| `get_node` | 3–4 ms |
| `get_neighbors` | 3 ms |
| `query_graph` (depth 3, 300-token budget) | 31 ms |
| First call after `graph.json` changed on disk (hot reload) | 56 ms |

The CLI costs about 0.27 s per call, mostly Python start-up.

**Hot reload:** `_load_graph` keys a cache on `(st_mtime_ns, st_size)`. Every tool call checks it and reloads if the file changed. The overlay sidecar reloads along with it.

---

## 9. Updating

| Trigger | Mechanism | Cost here |
|---|---|---|
| `git commit` | Post-commit hook: diffs the commit's changed files and launches a **detached** rebuild of those files (AST only, 600 s timeout, pinned interpreter). Then runs `reflect` if memories exist. | Returns immediately; rebuild 3–4 s |
| `git checkout` / `switch` | Post-checkout hook: the same, for a branch change | same |
| `git pull` / `merge` | Not hooked; the user runs `graphify update .` | 3.2–3.8 s |
| File saves | `graphify watch` (watchdog, 3 s debounce). Code changes rebuild; doc changes only set `needs_update`, because they need an LLM. | same |
| Docs changed | `/graphify --update` in the assistant, or `extract` with a backend | LLM cost |

**Incremental algorithm** (`watch._rebuild_code`):

1. Take the changed paths from the hook or watcher, plus any queued in `.pending_changes`.
2. Take a rebuild lock. A hook that can't get the lock appends its paths to the queue instead.
3. Re-extract only those files. Keep every other node from the existing graph. Drop nodes of files that no longer exist.
4. Rebuild the graph, re-cluster, remap communities to the previous build, and run the shrink guard.
5. Write `graph.json`, the report and the HTML atomically. Drain the queue again afterwards.

**Freshness gap.** The map reflects the last commit, or the last `watch` rebuild. Work an agent has not committed yet is invisible to it. The read guard detects this per file by comparing mtimes, and softens its message.

**Multiple checkouts:** `graphify merge-graphs` combines graphs, and `graphify global add` keeps a cross-repo graph at `~/.graphify/global-graph.json`, with nodes tagged by repo.

---

## 10. The work-memory overlay

This is the closest existing thing to Bifröst, so it is covered in full.

**The loop:**

1. After answering from the graph, the skill tells the agent to run:
   ```bash
   graphify save-result --question "<verbatim question>" --answer "<answer>" --nodes <cited labels> --outcome useful|dead_end|corrected [--correction "…"]
   ```
   This writes `graphify-out/memory/query_<timestamp>_<hash>_<slug>.md`, with YAML frontmatter (`type`, `date`, `question`, `contributor`, `outcome`, `source_nodes`) and the answer as the body.
2. `graphify reflect` runs from the post-commit hook, or at session start with `--if-stale`. It scores each cited node:
   - each citation is a signed value (`useful` counts positive, `dead_end` and `corrected` negative);
   - values decay with a 30-day half-life;
   - a node is `preferred` after at least 2 distinct `useful` results, otherwise `tentative`, or `contested` when it has both signs.
3. Reflect writes two outputs:
   - `reflections/LESSONS.md`: preferred sources, tentative ones, known dead ends and corrections, grouped by community;
   - `.graphify_learning.json`: `{version, generated_at, nodes: {<node id>: {status, score, uses, last, label, source_file, code_fingerprint, provenance[≤5]}}}`. Dead ends are left out.
4. At load, `serve` reads the sidecar. It marks an entry `stale` when the SHA-256 of its **whole source file** no longer matches `code_fingerprint`.
5. `query_graph` output then shows `learning=preferred:stale` on matching nodes.

**Tested here** with three saved results (two useful, one dead end), then `reflect`:

- `rrfScore()` became `preferred`, and `RRF_K` and `rrfTerm()` became `tentative`.
- The tag appeared in MCP `query_graph` output:
  ```text
  NODE rrfScore() [src=src/search/ranking.ts loc=L105 community=ranking.ts learning=preferred:stale]
  NODE rrfTerm() [src=src/search/ranking.ts loc=L61 community=ranking.ts learning=tentative:stale]
  ```
- **Not shown** in `get_node`, `get_neighbors`, or CLI `graphify query`.
- **Whole-file staleness:** appending one comment line at the end of the file marked both entries stale.
- **Memory docs feed back into the graph:** after the next `update`, the three memory files had become 15 document nodes (headings "Answer", "Outcome", and so on).

**Compared with Bifröst's needs:**

| | Graphify overlay | What Bifröst needs |
|---|---|---|
| Unit | "Was this node useful for a question" | Typed finding: warning, decision, known-issue, … |
| Content shown | A status word | A ≤280-character note, its author, its age, and votes |
| Writers | One user's assistant, through a CLI call | Any agent on any platform, plus extraction |
| Delivery | Only inside `query_graph` results | At the place, unasked; or silence |
| Staleness | Whole file | Per symbol span |
| Time | Decay only | Validity, supersession, votes |
| Presence and tasks | None | Core |

---

## 11. Other surfaces

- **`graphify prs`** is a PR dashboard.
  - It maps changed files to graph communities (`compute_pr_impact`).
  - `--conflicts` lists PRs that touch the same communities, as a merge-order risk.
  - It maps worktrees to branches to PRs, and can rank the review queue with an LLM.
  - This is the one place Graphify reasons about *who is working where*, which is relevant to Bifröst's presence.
- **`graphify affected X`** is a reverse traversal: everything that depends on X, which is the blast radius of a change.
- **`node-summaries-rfc.md`** proposes one-sentence file summaries (about 200–300 characters, `generated_by`, `summary_version`) stored next to the graph. It is not built yet. It shows the project wants short per-node text, the same shape as a Bifröst note.

---

## 12. Measurements

Taken on a copy of this repo: 141 code files, 9 Markdown files, 4 cores.

| Measurement | Value |
|---|---|
| Full code-only extraction | 3.0 s, 1,144 nodes, 3,223 edges, 62 communities |
| `graph.json` size | 1.46 MB (about 1.3 KB per node) |
| `update` after a one-file edit | 3.2–3.8 s (it reclusters everything) |
| Hook guard per tool call | 65 ms |
| MCP `get_node` / `query_graph` | 3–4 ms / 31 ms |
| Hot reload | 56 ms |
| IDs changed by a file rename | 13 of 13 in the file |
| Community reassignments from one added function | 263 IDs; 436 nodes with most of their community replaced |

---

## 13. Consequences for Bifröst

1. **Read `graph.json` and never write it.** It is regenerated, guarded and merged by Graphify. Bifröst's data lives in its own store, keyed by its own anchors.
2. **Anchor with Bifröst's own anchors.** Use the Graphify ID as a cache that is re-resolved whenever `graph.json` changes. File renames change every ID in the file.
3. **Symbol spans have to be derived.** Graphify gives start lines only. A symbol's span runs from its start line to the next symbol's start in the same file, or to the end of the file.
4. **Don't use communities as anchors.** For "area" orientation, smooth them over several builds.
5. **The delivery hook already works.** Bifröst has to put *specific* content into the same `PreToolUse` channel, and should stay well under Graphify's 65 ms.
6. **The map can lag.** Resolve by path and line first, and add map context only when `graph.json` is fresh for that file.
7. **Graphify's overlay proves the pattern** (sidecar keyed by node, joined at render time) and shows its limits: whole-file staleness, visible only in one tool, and no content. It is also a sign Graphify may grow in Bifröst's direction.
