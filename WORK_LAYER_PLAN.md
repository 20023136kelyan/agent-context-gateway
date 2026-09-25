# Work layer over the code map: plan

## Context

The task-outcome bench (commits 38865a8 and 3a59195) tested ACG as it stands: a search tool agents call while they work. It failed.
- **Agents never called it unprompted.** Across agy and Claude Code, every gateway arm without the hint made 0 calls.
- **With a hint, Claude called it and got worse.** On two tasks it took +98% time and +88% cost, with its first edit at 305 s vs 89 s. The hits were tool output and code fragments, and the context windows were 18–24k characters of raw tool output.
- **Every run passed without history.** Tasks that the code alone can answer don't need it.

The new direction, agreed with Kelyan on 2026-09-25: work history becomes a **layer over the project's code map** (graphify now; any map later). Every agent, in any tool, including parallel sessions of the same tool and subagents, knows what happened at a place in the code before it gets there:
- where work is happening, and what other agents are doing right now;
- decisions and why they were made;
- traps, shortcuts, discoveries, known issues and warnings.

Each item links back to its thread. It's the Dark Souls model: what others learned shows up where you are, and you never have to go looking for it.

**Settled decisions**
1. **For agents.** Everything the layer returns is written for an agent to read. Visual views are only for debugging and demos.
2. **One developer**, but a **paid service** (option A): the layer, its store and live sync stay on the developer's machine. The paid service does the model work only: extraction on open-weights models Kelyan hosts, behind the existing key proxy. Everything sent is scrubbed first and not retained. This keeps the 2026-09-23 decision that data stays local and the paid tier is the key proxy. A hosted copy (option B) for cloud agents or several machines is a possible later tier, so the store must be syncable.
3. **Agents may write to the layer** (add, correct, confirm) when they choose to. By default it informs only and never locks anything.
4. **All agents**, including same-tool parallel sessions and subagents, so the layer updates within seconds.
5. **Anchors are neutral** (file + symbol + line span at a commit), not map node ids. graphify is the first map adapter. We borrow Graphiti's time model (each item valid from a date, until a date, and replaced by another) without depending on Graphiti.
6. **Model calls in the product** run only on open-weights models Kelyan hosts (existing rule).

## Design principles, from the bench's evidence

- **Delivered by place, not by search.** Items arrive when an agent touches a file (via hooks) or asks the map about a place. No tool the agent has to decide to call.
- **Short, typed items.** Raw transcripts never go into what's delivered; a thread link gives depth. At most 3 items and about 150 tokens per injection, and nothing when there's nothing new. Silence beats noise.
- **Live.** Activity and presence show up within seconds, using the existing watcher.
- **Everything has a lifetime.** An item carries a validity interval and a source. It is replaced by a later item, marked "may be stale" when its code changes, or voted down.
- **Each phase has a bench gate.** Nothing gets built past a gate the bench hasn't passed.

## Data model (local SQLite `layer.sqlite` in the state dir, like `actions.sqlite`)

- **Anchor:** `{ path (repo-relative), symbol?, span?: {start,end}, commit? }`.
  - Resolved to a map node (and region) by a map adapter, or kept at file level when there is no map.
  - Work on code the map hasn't seen yet still gets recorded, and is attached to a node at the next map build.
- **activity** (mechanical, no LLM):
  - fields: `harness, sessionId, agentId (subagent), taskSeq, kind: read|search|edit|run|discuss, anchor, ts, turnId, ok`;
  - a superset of today's `actions` rows.
- **presence** (derived, live):
  - which sessions are active, the anchors each touched in the last N minutes, and each one's current task request;
  - built from the watcher plus activity.
- **findings** (meaning, not mechanics):
  - `type: decision|discovery|warning|known-issue|how-to|in-progress|open-thread`;
  - `text ≤ 280 chars` and an optional `why`;
  - `anchors[]`;
  - `source {harness, sessionId, turnIds}`;
  - `author: extractor|agent|heuristic`;
  - `validFrom`, `validUntil`, `supersededBy`;
  - `confidence`, `votes {confirmed, contradicted}`.
- **Tasks** stay as they are (`TaskOutcome` in `src/outcomes/outcome.ts`), linked to anchors through activity.

## Phases, each with a gate

### Phase 0: upper-bound test (gate for everything else)
Does place-triggered context help at all, when it's perfect?
- **Hand-written findings for bench tasks.** Write them from the history before each task's `asOf`: traps, decisions, the known-failing tests (what `environmentNote` covers today, moved into findings), and the Codex subagent field trace.
- **Add 3–4 tasks with traps,** where a finding changes what an agent does. Each must pass `bench validate`.
- **Add the bench arm `oracle-layer`.** The Claude adapter writes a project `.claude/settings.json` PostToolUse hook. The bench already loads project settings through `--setting-sources project`. The hook prints the findings for the file just read or edited, as `hookSpecificOutput.additionalContext`.
- **Optional arm `map`:** a graphify skill and graph in the workspace. This measures the map itself.
- **Gate:** on at least 3 repeats, the oracle arm is ≥15% faster or cheaper with no drop in pass rate, or passes trap tasks that `none` fails. **If it fails, stop:** no extractor can beat perfect notes.

### Phase 1: capture and anchors (mechanical, no LLM)
- **Extend `actionsOfCall`** in `src/actions/store.ts`:
  - Read/view tools and Grep/Glob become `read` and `search`;
  - shell commands yield the files they touch (reuse `extractFileRefs` in `src/adapters/text.ts`);
  - edit tools keep their line span where the input has it.
  - Bump `PARSE_VERSION` so stores re-sync.
  - Today the action store sees 35 of the map's 175 files; tool calls reach 125.
- **New `src/layer/anchor.ts`:** normalizes paths to repo-relative (reuse `callerProject` and `src/adapters/repo.ts`), and resolves spans to symbols through a map adapter.
- **New `src/layer/maps/graphify.ts`:** reads `graphify-out/graph.json` (`source_file`, `label`, `source_location`, `community_name`) and resolves a span to the node with the nearest start line at or before it.
- **New `src/layer/store.ts`:** activity and presence tables, fed from the watcher's sync path (`src/watch.ts` → `recordActions` in `src/commands.ts`).
- **MCP tool `layer.at({path|symbol})`** returns a compact brief for a place:
  - who is active there now;
  - recent tasks with status (from `outcome.ts`);
  - thread links.
- **`acg hook-place`** (Claude Code PostToolUse on Read/Edit/Write/MultiEdit) injects what's new to this session for that file, deduplicated per session. **SessionStart** injects "where the work is" in this repo.
  - Install both through `src/setup.ts`, next to the existing UserPromptSubmit and SessionEnd hooks.
- **Gate:** the `layer` arm (activity and presence only) costs no more than `none` on the existing tasks.

### Phase 2: findings
- **Agent-written:** MCP tools `layer.note({anchor,type,text,why})` and `layer.vote({id,confirm|contradict})`.
- **Extracted:** one pass per finished task, not per turn, which batches the cost.
  - Input: the task's request, the agent's reply (`TaskOutcome.reply`), and the turns around its edits and failed checks. Scrubbed with `scrubDeep`.
  - Output: typed findings with anchors.
  - Without a model: a heuristic path (`src/decisions/extract.ts` and `cues.ts`, supersession cues in `src/temporal/bi-temporal.ts`), labelled `heuristic`.
- **Lifecycle:**
  - replaced by a newer finding of the same type on the same anchor (reuse the ideas in `bi-temporal.ts`);
  - marked "may be stale" when the anchored span's content hash changes at a later commit;
  - votes.
- **`layer.where({topic})`** returns places, not transcripts. The existing search index (BM25 + vectors) becomes an internal index over findings and turns.
- **Extraction-quality eval:** precision on a labelled set, using the judge-with-agy pipeline (`scripts/judge-pairs.ts`).
- **Gate:** the `layer-full` arm gets at least half of the oracle arm's gain from Phase 0.

### Phase 3: the paid service and packaging
- **Proxy route `extract`** in `src/proxy/server.ts` and `src/vendors.ts`. It runs an open-weights model on Kelyan's GPU (vLLM), metered like the other routes, with a free quota and the existing no-logging policy.
  - Choose the model by measurement: precision against cost per 1k tasks on the Phase 2 labelled set.
- **`acg init`** wires it up: the hooks, the MCP server, a one-line pointer in AGENTS.md / CLAUDE.md, and graphify detection.
- **Overlay export** `graphify-out/work-layer.json`, keyed by node id, plus a graph.html overlay for demos: heat by region, trails, per-node timelines, live sessions.

### Later
- Hooks for Codex and Cursor, where they allow it.
- A hosted, synced copy (option B).
- Decide which search-era features (artifact graph, lineage, live search, decide) to fold into the layer or retire. Decide after Phase 2, not before.

## Critical files

- **Extend:**
  - `src/actions/store.ts` (`actionsOfCall`, schema);
  - `src/adapters/claude.ts` and `src/adapters/codex.ts` (action capture);
  - `src/watch.ts`;
  - `src/commands.ts` (`recordActions`);
  - `src/transports/mcp.ts` (layer tools);
  - `src/cli.ts` (`hook-place`);
  - `src/setup.ts` (hook install);
  - `src/proxy/server.ts` and `src/vendors.ts` (`extract` route);
  - `src/settings.ts`.
- **New:** `src/layer/{store,anchor,brief,extract,lifecycle}.ts` and `src/layer/maps/graphify.ts`.
- **Bench:**
  - `bench/lib/runner.ts` (arms `oracle-layer`, `map`, `layer`, `layer-full`);
  - `bench/lib/agents.ts` (write the project hook settings);
  - `bench/suites/acg-self.json` (trap tasks, oracle findings per task).
- **Reuse:**
  - `TaskOutcome`, `userUtterance` and `taskDigest` (`src/outcomes/outcome.ts`);
  - `extractFileRefs` (`src/adapters/text.ts`);
  - `identifierWords` (`src/search/files.ts`);
  - `scrubDeep` (`src/security/scrub.ts`);
  - `InvalidationRecord` and the supersession cues (`src/temporal/bi-temporal.ts`);
  - `ProxyStore` and metering (`src/proxy/store.ts`);
  - the GATEWAY_AS_OF pin (`pinAsOf` in `src/commands.ts`), so bench runs see the layer as of `asOf`.

## Verification

- **Unit tests (vitest)** for each new module:
  - anchor resolution against a small fixture `graph.json`;
  - activity capture from real-shaped tool calls: Read, Grep, shell `sed`/`cat`/heredoc writes, apply_patch;
  - presence expiry;
  - brief size limits;
  - the finding lifecycle (replaced, stale on a hash change, votes).
- **Checks:** `npx tsc --noEmit`, `npx tsc -p bench`, and the full `npx vitest run` before each commit.
- **Bench gates** as above, with ≥3 repeats per cell, the report's paired ratios, and cost. Report n and noise honestly: agy run-to-run noise was about ±8% time and ±19% tokens.
- **End to end on this repo:** project ACG's own history onto its graphify map. Check that `layer.at("src/outcomes/outcome.ts")` returns its tasks, and that a live second Claude session shows up in presence within seconds. Check that the PostToolUse hook injects on the first read of a file, and not again on later reads.

## Status

- 2026-09-26: plan agreed. Next: Phase 0 (oracle findings, trap tasks, the
  `oracle-layer` arm), then a Claude and agy run, asking before spending Claude quota.
