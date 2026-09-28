# Bifröst on a system map: design from the study

This document turns the Graphify and Graphiti studies into a design for Bifröst ([Graphify](./graphify.md), [Graphiti](./graphiti.md)).

**The model:**

- A **system map** such as Graphify describes the codebase. It is the terrain every agent works across.
- **Bifröst** is a shared log laid over that map. It records what agents learned, tried, decided and are doing at each place. Every agent, in every agent system, can read it at any time.
- **Built by a service, not by the user's agents.** The log is built and maintained from the agents' work history. Agents don't have to write anything, and the user's own model and tokens are never used to maintain it.
- **Agents can correct entries,** but that is a secondary channel.

Contents:

1. How Bifröst is built and updated
2. The event pipeline in detail
3. Reconciliation: add, update, supersede, dismiss
4. The map as the anchor
5. Keeping up with the map and the code
6. Serving the log to agents
7. Deployment boundary
8. What to build first

---

## 1. How Bifröst is built and updated

```text
 agent work history            events                 classification              the log
 ─────────────────             ──────                 ──────────────              ───────
 Claude Code JSONL  ┐
 Codex session logs ├─► adapters ─► normalize ─► place on map ─► episodes ─► classify ─► reconcile ─► entries
 Cursor state DB    │   (local)     + scrub      (Graphify)       (group)     (rules,     (add /        (anchored,
 OpenCode, …        │                                                         then       update /      typed,
 git (commits,      ┘                                                         service    supersede /   temporal)
 reverts, checkouts)                                                          models)    dismiss)
                                                        │                                                    │
                                                        └──────► activity + presence (mechanical) ───────────┤
                                                                                                             ▼
                                                                           delivery to every agent, at the place
```

1. **Streamline.** Work history that already exists is turned into a stream of typed events. Agent tools write full traces of their sessions anyway, and git records what landed. Nothing extra is asked of the agent.
2. **Place.** Each event is resolved to places on the system map: files, symbols, line ranges.
3. **Classify.** Events are grouped into episodes (one attempt at one thing) and classified. Cheap rules run first, then the service's own models only where rules can't decide.
4. **Reconcile.** Each classified episode is compared with what the log already holds at those places. It either **adds** an entry, **updates** one (reinforces, refines, changes a task's state, or supersedes it), or is **dismissed**.
5. **Deliver.** Whenever any agent reaches a place, the current entries there are available to it.
6. **Re-validate.** Code changes, reverts and later work keep flowing through the same pipeline, so entries are confirmed, flagged stale, or superseded without anyone curating them.

Agents' direct edits (confirm, down-vote, correct) enter at step 4 as high-trust events. They do not bypass the pipeline.

---

## 2. The event pipeline in detail

### 2.1 Sources

| Source | What it gives | Existing code |
|---|---|---|
| Claude Code session JSONL | Prompts, replies, every tool call with inputs and results | `src/adapters/claude.ts` |
| Codex session logs | Same | `src/adapters/codex.ts` |
| Cursor state database | Same, less structured | `src/adapters/cursor.ts` |
| OpenCode, SWE-style trajectories | Same | `src/adapters/opencode.ts`, `trajectories.ts` |
| git | Commits, reverts, branch switches, renames, merged diffs | `src/adapters/git.ts`, `src/git/hooks.ts` |
| Live hooks (optional) | The same tool events seconds earlier than the traces, for presence | `src/setup.ts` hook installer |
| Test and CI output (later) | Pass/fail per test, over time | none |

The adapters read the harnesses' native files incrementally, using byte offsets and cursors, as the search product already does.

### 2.2 Event schema

```ts
interface WorkEvent {
  id: string;
  at: string;                        // when it happened
  session: string; agentSystem: "claude-code" | "codex" | "cursor" | string;
  repo: string; commit?: string;     // HEAD at the time
  kind:
    | "read" | "search" | "edit" | "create" | "delete" | "rename"
    | "run" | "test"                 // shell command, test command
    | "prompt" | "reply"             // natural-language turns (scrubbed)
    | "commit" | "revert" | "checkout";
  places: Place[];                   // resolved on the map (§4)
  outcome?: "ok" | "error" | "fail" | "pass" | "interrupted";
  digest: string;                    // short scrubbed summary: command, error signature, edit hunk header
  ref: { source: string; offset: number };  // back to the native trace; never uploaded
}
```

Notes:

- **Scrubbing happens locally, at normalization.** Secrets, tokens, keys and paths outside the repo are removed before anything leaves the machine (§7).
- **`places` come from the map.** An edit's hunk becomes the symbols it overlaps. A test command becomes the test file and, through the map, the code under test. A stack trace becomes the frames' symbols. A `grep` result becomes the files hit.
- **Activity and presence need nothing more.** They come straight from placed events: "who touched `refreshSession` in the last 10 minutes" is a query over events. No model is involved.

### 2.3 Episodes

Single events are too small to learn from. Events are grouped into **episodes**, each one attempt at one thing:

- **boundaries:** a new user prompt, an idle gap, a commit, or a switch to a different area of the map;
- **each episode keeps:** its prompt (the intent), its places, the edits made, the commands run and their outcomes, and how it ended (committed, reverted, abandoned, still open).

### 2.4 Classification

Two tiers, so the service's models run only where they add something.

**Tier 1: rules, with no model.** These alone cover task state, a large share of warnings, and all activity:

| Signal | Classification |
|---|---|
| Edit followed by the same failing test or command, several times at the same place | candidate `warning` or `known-issue` (a struggle) |
| Error that went away after an edit | candidate `discovery` (fix found), linked to the error signature |
| `git revert` of a commit | the task on that commit's places becomes **reverted**; related entries are candidates for supersede |
| Tests pass after a failing run, then commit | task becomes **verified** |
| Session ended with uncommitted edits | `in-progress` or `open-thread` at those places |
| Conclusion language in replies ("we'll go with…", "decided…", "because…") | candidate `decision`; the cue lists in `src/decisions/` already do this |
| Reads and searches only, no outcome | activity only, **dismissed** as knowledge |

**Tier 2: service models, only for candidates from tier 1.** A hosted open-weight model gets the scrubbed episode digest (not the full transcript) and returns, constrained to the schema:

- keep or drop;
- type;
- a one-line text of at most 280 characters;
- confidence;
- which places the finding really belongs to, chosen from the episode's placed events.

This is the step where extraction happens, and it runs in the service, metered, with no retention.

---

## 3. Reconciliation: add, update, supersede, dismiss

Every classified candidate is compared with the live entries at its places, including one hop out on the map.

| Outcome | When | Effect |
|---|---|---|
| **Add** | Nothing at those places covers it | New entry: `validFrom = episode time`, evidence = this episode |
| **Reinforce** | An entry says the same thing | Add the episode as evidence; raise confidence; update `lastSeen`. The text is unchanged. |
| **Refine** | Same topic, more precise or with new detail | New text; the old text is kept in the entry's history |
| **Change state** | A task-state signal (verified, failing, reverted) | Update the task; supersede `in-progress` notes that it settles |
| **Supersede** | The new evidence contradicts the entry | Old entry gets `validUntil` and `supersededBy`, and is kept but no longer served as current |
| **Dismiss** | Noise, duplicate with nothing new, or below the confidence floor | Nothing written. The episode stays as activity. |

Rules decide first:

- a revert supersedes the finding that described the reverted change;
- a fix supersedes the `known-issue` it fixes;
- an exact duplicate reinforces.

A model is asked only for the ambiguous remainder: "does this contradict, refine, or repeat the entry?". This is the same question Graphiti asks in its `resolve_edge` step, but run by the service and applied only to candidates the rules could not settle.

**Agent edits** are events of kind `vote`, `correct` or `supersede`. They run through the same table with high trust. A down-vote threshold dismisses an entry. A correction refines it.

**Provenance.** Every entry keeps its evidence list, as links to episodes. Graphiti's model is the same: facts point back to the episodes that produced them. When evidence is removed (a session deleted, a branch dropped), entries that depended only on it are withdrawn.

---

## 4. The map as the anchor

### 4.1 Anchor record

```ts
interface Anchor {
  repo: string;
  path: string;                 // repo-relative, as of `commit`
  symbol?: string;              // "SearchService.search"
  lineStart?: number; lineEnd?: number;
  commit: string;
  spanHash?: string;            // hash of the normalized symbol text
  binding?: { map: "graphify"; nodeId: string; builtAtCommit?: string };  // cache only
}
```

Precision, finest first: symbol, then line range, then file, then directory, then repository.

The Graphify node ID is stored only as a cache. File renames replaced every ID in the file during the study, and communities reshuffle on small edits. Areas shown to agents use a smoothed community label, never a community ID.

### 4.2 Map adapter

The map sits behind an interface, so Graphify is the first map and not the only one:

```ts
interface MapAdapter {
  version(): { builtAtCommit?: string; mtimeMs: number };
  isFreshFor(path: string): boolean;
  symbolsIn(path: string): MapSymbol[];               // ordered; endLine derived from next start
  nodeFor(path: string, symbol?: string): MapSymbol | null;
  neighbors(nodeId: string, opts: { relations?: string[]; hops?: 1 | 2 }): MapEdge[];
  dependents(nodeId: string, depth?: number): MapSymbol[];
  area(nodeId: string): { label: string } | null;
}
```

The Graphify adapter reads `graphify-out/graph.json` and re-reads it when its `(mtime, size)` changes. It never writes to it.

### 4.3 Placing an event

1. **Path:** normalize to repo-relative; drop anything outside the repo.
2. **Lines touched:** from the edit hunk, the read range, the stack frame, or the grep hit.
3. **Symbols:** those whose span overlaps the lines, from the map when it is fresh for the file. Otherwise a local parse of the file as it was at that moment.
4. **Links:** callers, callees and tests from the map's `calls`, `imports` and `implements` edges. These are stored on the event, so later retrieval can surface "someone struggled with what you are about to call".

---

## 5. Keeping up with the map and the code

- **Map rebuilt** (`graph.json` changed): re-bind every anchor from `path` and `symbol`.
  - If a symbol moved within its file, follow it by label.
  - If its file was renamed, follow git's rename detection (`git diff -M`) from the commit events already in the stream.
  - If it is gone, the anchor is **orphaned**: it is served only in session-start orientation and topic lookups, as "place no longer exists".
- **Code changed at an anchor** (a commit event whose hunk overlaps the span, or the `spanHash` differs): the entry is flagged "code changed since". The next episode at that place re-confirms it (reinforce), refines it, or supersedes it through normal reconciliation. Nobody curates by hand.
- **Map behind the working tree:** events are placed from the file as it was at the time. The binding catches up on the next map build.
- **Decay:** activity ages out of place-based delivery quickly. A finding stays current until it is superseded, voted down, or has sat flagged stale long enough without re-confirmation. The age limits are an open parameter.

---

## 6. Serving the log to agents

### 6.1 Channels by platform

| Platform | Delivered at the place | Session start | Pull (MCP) |
|---|---|---|---|
| Claude Code | `PreToolUse` on `Read\|Edit\|Write\|MultiEdit\|Grep` → `additionalContext` | `SessionStart` hook | Yes |
| Gemini CLI | `BeforeTool` → `additionalContext` | Instruction file | Yes |
| Codex | Not possible: Codex Desktop rejects `additionalContext` on `PreToolUse` | `AGENTS.md` | Yes |
| Cursor | Not possible | `.cursor/rules` (`alwaysApply`) | Yes |

These are the channels Graphify already relies on. Its hooks inject a fixed reminder, while Bifröst injects the entries for the place being touched.

### 6.2 Latency

- A tiny hook shim talks to a warm local daemon over a socket, with a 30 ms p95 budget.
- The daemon serves from a local replica of the log for this repository. The service pushes updates to that replica; it is not queried on the hot path.
- If the daemon doesn't answer in time, the shim prints nothing and never blocks the agent.

For comparison, Graphify's guard starts a new process per call (65 ms here) and carries no content.

### 6.3 What the agent sees

```text
BIFRÖST src/auth/refresh.ts › refreshSession
  WARNING   3d · codex · seen 3×      Retrying inside refreshSession() loops on 401s; the retry was reverted in a1b2c3d.
  TASK      failing · claude-code · live 4m   Token rotation under concurrent refresh
  DECISION  9d · claude-code          Refresh fails fast; SessionGuard owns retries.   [code changed since]
```

Rules:

- **Limits:** at most 3 entries and 150 tokens. Print nothing when nothing is relevant.
- **Once per session:** each entry is shown once per session, unless it changed or its code changed since.
- **Order:** direct place before neighbours. `warning` and `known-issue`, then live `in-progress`, then `decision`, `open-thread`, `how-to`. Then evidence count, then recency.
- **Current only:** superseded entries are never shown as current. Graphiti's default search returns superseded facts; Bifröst's default excludes them.
- **Sanitized:** every line is sanitized before it enters model context.

### 6.4 Pull tools and corrections

| Tool | Purpose |
|---|---|
| `bifrost.at(path, symbol?)` | The entries for a place, with a larger budget |
| `bifrost.where(topic)` | Places where the log has entries on a topic. Returns places, not transcripts. |
| `bifrost.confirm(id)`, `bifrost.dispute(id, reason?)`, `bifrost.correct(id, text)` | Correction events into §3 |

---

## 7. Deployment boundary

| Runs locally | Runs in the service |
|---|---|
| Harness and git adapters | Tier-2 classification on open-weight models |
| Normalization and scrubbing | Reconciliation questions the rules can't settle |
| Placement on the map (reads `graph.json`) | The shared log for teams and machines, and sync |
| Tier-1 rules, activity, presence | Metering |
| Local replica of the log, daemon, hook shim | |

- **What crosses the boundary:** scrubbed episode digests going up (commands, error signatures, hunk headers, placed symbols, short excerpts of intent), and log entries coming down.
- **What stays local:** raw transcripts. The service holds no episode content after classification. That is the no-retention contract in the architecture doc.
- **What the user's model does:** nothing. Bifröst never spends the user's LLM tokens to build or maintain the log. Their agents only read it, plus the occasional correction.

---

## 8. What to build first

The upper-bound experiment still comes first. It uses **hand-written** entries to test whether delivery at the place helps at all. If that passes, the pipeline is built in this order:

1. Graphify adapter, and placement of events from the Claude Code and Codex adapters. Measure how many edit and test events resolve to a symbol.
2. Episode segmentation and tier-1 rules. Measure how many real sessions yield a candidate, and how many of those a person judges worth keeping.
3. Reconciliation with rules only: revert, fix and duplicate handling.
4. Tier-2 classification on a hosted open-weight model, over candidates only. Measure cost per session.
5. Daemon, local replica, and the Claude Code `PreToolUse` shim, within the 30 ms budget.
