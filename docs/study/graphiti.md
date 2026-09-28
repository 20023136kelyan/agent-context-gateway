# Graphiti in depth

Version 0.30.2 (`getzep/graphiti`, commit `6b4b56f`, Apache-2.0), studied from source. I also ran it on the embedded Kuzu driver, with a scripted stand-in LLM and a local hashing embedder, to see its behaviour without API keys. The probe scripts are in [`probes/`](./probes/).

Contents:

1. What it is, and what it is not
2. The data model
3. Construction: how an episode becomes graph
4. Time: validity, supersession, expiry
5. Search
6. Storage drivers
7. How agents discover and use it
8. Updating
9. Measurements and defects found
10. Consequences for Bifröst

---

## 1. What it is, and what it is not

Graphiti is "a framework for building and querying temporal context graphs for AI agents", and the open-source core of Zep's hosted memory product. It keeps an evolving graph of **entities** and **facts about them**, extracted by an LLM from a stream of **episodes**: messages, text or JSON.

**It is not a codebase map.** It has no parser and no notion of files, symbols, lines or commits. Code only gets in as text an LLM reads, or as facts written directly with `add_triplet`. In Bifröst's architecture it corresponds to the **work store and its temporal semantics**, not to the map.

---

## 2. The data model

Everything is partitioned by `group_id` (letters, digits, `-`, `_`). Since late September 2026, each group can also route to its own database.

| Type | Key fields | Role |
|---|---|---|
| `EpisodicNode` | `content`, `source` (`message`/`text`/`json`), `source_description`, `valid_at` (when the events happened), `created_at` (ingest time), `entity_edges[]` | Raw input and provenance. Every derived fact points back here. |
| `EntityNode` | `name`, `summary` (rewritten as facts arrive), `attributes` (custom typed fields), `labels` (custom types), `name_embedding` | A thing: a person, product, concept… |
| `EntityEdge` (a fact) | `name` (relation type), `fact` (one sentence), `fact_embedding`, `episodes[]`, `valid_at`, `invalid_at`, `expired_at`, `reference_time`, `attributes` | A statement about two entities, with its validity window |
| `EpisodicEdge` (`MENTIONS`) | episode → entity | Which episode mentioned which entity |
| `CommunityNode` / `CommunityEdge` | `name`, `summary` | LLM-summarized clusters, built on demand |
| `SagaNode`, `HAS_EPISODE`, `NEXT_EPISODE` | `summary`, first and last episode | An ordered chain of episodes, such as one conversation or task |

**Custom ontology.** Developers pass Pydantic models as `entity_types` and `edge_types`, plus an `edge_type_map` that restricts which relation types may join which entity types. The LLM classifies into those types and fills their attributes. `excluded_entity_types` and `custom_extraction_instructions` steer extraction further.

---

## 3. Construction: how an episode becomes graph

`Graphiti.add_episode(name, episode_body, source_description, reference_time, group_id, …)` runs these steps (`graphiti.py` lines 1043–1290):

1. **Context:** load the last `RELEVANT_SCHEMA_LIMIT` (10) episodes of the group, or the ones named in `previous_episode_uuids`.
2. **Extract entities** (LLM, `ExtractedEntities`): names and a type for each.
3. **Resolve entities** (`resolve_extracted_nodes`):
   1. find candidates by hybrid search over existing entities;
   2. compare deterministically: exact normalized name, then fuzzy matching (MinHash, 32 permutations, bands of 4, Jaccard ≥ 0.9 on 3-shingles, with an entropy gate for short or low-information names);
   3. only names still unresolved go to the LLM for a duplicate decision.
4. **Extract facts** (LLM, `ExtractedEdges`): source, target, relation type, the fact sentence, and optional `valid_at`/`invalid_at`.
5. **Resolve facts** (`resolve_extracted_edges`):
   1. embed each new fact;
   2. gather *related* facts (existing edges between the same two entities, then a hybrid search among those);
   3. gather *invalidation candidates* (a hybrid search over all facts in the group);
   4. if the fact text and endpoints match exactly, reuse the existing edge with no LLM call;
   5. otherwise one LLM call (`dedupe_edges.resolve_edge` → `EdgeDuplicate`) returns `duplicate_facts` and `contradicted_facts` as index lists;
   6. extract timestamps with a small LLM call when the fact has none.
6. **Invalidate** contradicted facts (§4).
7. **Attributes and summaries** (LLM, `SummarizedEntities`, batched): rewrite entity summaries from the new facts, and fill custom attributes.
8. **Save:** the episode, the `MENTIONS` edges and saga links, then all nodes and edges in bulk, with embeddings.
9. **Communities** (optional, `update_communities=True`): LLM re-summarization.

The prompts are in `graphiti_core/prompts/`: `extract_nodes`, `extract_edges`, `dedupe_nodes`, `dedupe_edges`, `summarize_nodes`, `summarize_sagas`. Every structured call appends the Pydantic JSON schema to the prompt and expects JSON back.

**Other write paths:**

- `add_episode_bulk`: batch ingestion with shared dedup.
- `add_triplet(source, edge, target)`: write a fact directly.
  - Skips extraction.
  - Still embeds everything and resolves entities.
  - Still makes the `resolve_edge` LLM call when similar facts exist.
- `remove_episode`: deletes an episode and any entity or fact that only it created.

---

## 4. Time: validity, supersession, expiry

This is Graphiti's most relevant idea for Bifröst.

| Field | Meaning |
|---|---|
| `valid_at` | When the fact became true in the world, taken from the text or the episode's `reference_time` |
| `invalid_at` | When it stopped being true |
| `expired_at` | When the *system* learned it was no longer true (ingest time) |
| `created_at` | When the edge was written |

**Supersession rule** (`resolve_edge_contradictions`). For each fact the LLM marks as contradicted:

- if the two validity windows don't overlap, nothing happens;
- if the old fact started before the new one, it gets `invalid_at = new.valid_at` and `expired_at = now`.

Facts are never deleted. History remains queryable with date filters.

**Tested here:**

1. Wrote the warning "Adding a retry inside refreshSession loops forever on 401 responses", valid from 20 Sep.
2. Wrote the decision "The retry in refreshSession was reverted in a1b2c3d; refresh now fails fast", valid from 23 Sep.
3. The scripted LLM marked the first as contradicted. The warning got `invalid_at = 23 Sep` and an `expired_at`.

That is exactly the architecture's `validFrom` / `supersededBy` behaviour, with the decision about *whether* something is superseded left to an LLM.

---

## 5. Search

`Graphiti.search(query, center_node_uuid?, group_ids, num_results=10, search_filter)` returns facts. `search_()` takes a full `SearchConfig` and returns edges, nodes, episodes and communities together.

**Methods, per target type:**

| Target | Methods |
|---|---|
| Edges and nodes | `bm25` (the database's full-text index), `cosine_similarity` (embedding), `bfs` (graph walk up to depth 3 from origin nodes, or from the nodes the other methods found) |
| Episodes | `bm25` |
| Communities | `bm25`, `cosine_similarity` |

**Rerankers:**

| Reranker | What it does |
|---|---|
| `rrf` | Reciprocal rank fusion |
| `mmr` | Maximal marginal relevance, for diversity |
| `cross_encoder` | OpenAI, Gemini or BGE rerankers |
| `episode_mentions` | Favours often-mentioned entities |
| `node_distance` | Favours results near `center_node_uuid`. **In code this is one hop only:** a node directly linked to the centre scores 1, and everything else is ∞. |

There are 16 preset recipes, from `EDGE_HYBRID_SEARCH_RRF` (the default) to `COMBINED_HYBRID_SEARCH_CROSS_ENCODER`.

**Filters** (`SearchFilters`): `node_labels`, `edge_types`, `edge_uuids`, `property_filters`, and date conditions on `valid_at`, `invalid_at`, `created_at` and `expired_at` (lists of AND/OR groups, including `IS NULL`).

**Default behaviour with superseded facts:** nothing in `graphiti_core` filters out invalidated facts by default. In the test above, the default search returned the reverted warning alongside the decision. Only an explicit `invalid_at IS NULL` filter left just the current one. A caller that wants "what is true now" has to add that filter.

---

## 6. Storage drivers

| Driver | Status | Deployment |
|---|---|---|
| Neo4j | Main | Server; the full-text and vector indexes are created by `build_indices_and_constraints` |
| FalkorDB | Default in the MCP Docker setup | Server (Redis-based) |
| Neptune | Supported | AWS, with OpenSearch for full text |
| Kuzu | **Deprecated**: "the upstream Kuzu project is no longer maintained" | Embedded; the only option without a server |

The driver abstraction (`driver/`) has per-provider `operations/` and `search_interface` modules, so a new backend implements query builders plus a small set of operations.

**The embedded path is broken on current main.** Two defects found while testing:

1. `KuzuDriver.build_indices_and_constraints` is a no-op, so the full-text indexes are never created. Every search then fails with `Table RelatesToNode_ doesn't have an index with name edge_name_and_fact`. Creating them by hand (`INSTALL fts; LOAD fts;` then the four `CREATE_FTS_INDEX` calls) fixes it.
2. `add_episode` crashes with `'KuzuDriver' object has no attribute '_database'`. The new per-group routing (`_resolve_request_scope`) assumes a field Kuzu doesn't set.

In practice, Graphiti needs a graph database **server**.

**Telemetry:** Graphiti sends anonymous PostHog events **by default**. `GRAPHITI_TELEMETRY_ENABLED=false` turns it off.

---

## 7. How agents discover and use it

**MCP server** (`mcp_server/`, streamable HTTP at `/mcp/` or stdio; FalkorDB plus the server in one container by default). The server's `instructions` text explains episodes, entities, facts, `group_id` and the bi-temporal model, and lists the tools:

| Tool | Purpose |
|---|---|
| `add_memory` | Queue an episode; **returns immediately**. Episodes for the same `group_id` are processed one at a time in the background. |
| `add_triplet` | Write one fact directly |
| `search_nodes` | Hybrid entity search, with type filter and `center_node_uuid` |
| `search_memory_facts` | Hybrid fact search, with edge-type and `valid_at`/`invalid_at` range filters |
| `get_episodes`, `get_entity_edge`, `get_episode_entities` | Fetch records and trace provenance |
| `summarize_saga`, `build_communities` | LLM summaries |
| `delete_episode`, `delete_entity_edge`, `clear_graph` | Remove data |
| `get_status` | Health |

Entity types come from server config. The built-ins are Preference, Requirement, Procedure, Location, Event, Organization, Document, and others.

**REST server** (`server/`, FastAPI):

- ingest: `POST /messages`, `/entity-node`, `/clear`;
- delete: `/entity-edge/{uuid}`, `/group/{group_id}`, `/episode/{uuid}`;
- retrieve: `POST /search`, `POST /get-memory`, `GET /entity-edge/{uuid}`, `GET /episodes/{group_id}`.

**No hooks and no always-on instruction files.** An agent uses Graphiti only if it decides to call a tool, or if the application around it calls `search` and puts the results in the prompt. That is the pattern Zep's hosted product uses.

---

## 8. Updating

- **Continuous and incremental:** each episode updates the graph in place. There is no rebuild step.
- **Nothing watches the world.** Graphiti learns only what it is told. When code changes, no fact is marked stale unless an episode says so and the LLM connects them.
- **Cost scales with content:** a few LLM calls for every episode, plus one per ambiguous entity, one per new fact that has neighbours, and more for custom attributes.

---

## 9. Measurements and defects found

Run on Kuzu in memory, with the FTS indexes created by hand and the `_database` attribute patched. The scripted LLM returned fixed JSON, so these times are **pipeline overhead only**. With a real model, each LLM call adds a full round trip.

| Operation | LLM calls | Time (overhead only) |
|---|---|---|
| `add_triplet`, nothing similar in the group | 0 | 102 ms |
| `add_triplet`, similar facts exist | 1 (`EdgeDuplicate`) | 75 ms |
| `add_episode`, first time (3 entities, 1 fact) | 4 (entities, facts, timestamps, summaries) | 204 ms |
| `add_episode`, same content again | 3 (entities, facts, summaries); dedup and the fact fast path skip the rest | 77 ms |

Defects and gaps found:

1. Default search returns invalidated facts (§5).
2. Kuzu full-text indexes are never created (§6).
3. Kuzu `add_episode` crashes on `_database` (§6).
4. `add_triplet` returned the same invalidated edge **twice**, because it appeared in both candidate lists.
5. `node_distance` is one hop only; there is no real distance.
6. Telemetry is on by default.

---

## 10. Consequences for Bifröst

1. **Graphiti can't be the anchor.** A Graphiti "code map" would have to be built by another tool and written in as triplets. Graphify can already push its graph into Neo4j or FalkorDB, the same databases Graphiti uses. That combination is possible but heavy: a database server and LLM calls on writes.
2. **Adopt its time model.**
   - Keep `valid_at`, `invalid_at` and `expired_at` separately.
   - Keep provenance episodes.
   - Supersede and never delete.
   - Bifröst's supersession should be **explicit** (an agent or a rule says "this replaces that") and *suggested* by an LLM only when needed. A hand-written note in the experiment must never be silently invalidated by a model's guess.
3. **Default to "true now" when serving.** The opposite of Graphiti's default: superseded notes appear only when asked for, or as "superseded by…".
4. **Keep writes cheap.** A session-end note must be a local write in milliseconds, with no mandatory LLM. Extraction, if any, runs offline.
5. **Graphiti as a later integration.** Teams already on Zep or Graphiti could receive Bifröst findings as triplets (file or symbol entity → typed fact → entity), with one `group_id` per repository. `src/adapters/zep.ts` already reads Zep.
6. **Competitive position.** Zep and Graphiti own "temporal memory for agents" in general. What they don't do: knowing *where in the code* a fact applies, and delivering it when the agent gets there. That remains Bifröst's ground.
