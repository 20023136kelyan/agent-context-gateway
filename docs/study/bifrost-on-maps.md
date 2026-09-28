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
6. Presence and objectives
7. Serving the log to agents
8. Deployment boundary
9. What to build first

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
                                                        └──────► activity + presence (§6) ───────────────────┤
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
- **Activity comes straight from placed events.** "Who touched `refreshSession` in the last 10 minutes" is a query over events, with no model. Presence needs more: whether the session is working *now*, and what it is trying to do. That is §6.

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

## 6. Presence and objectives

Presence is the live part of Bifröst. Two questions have to be answered for every agent session, continuously:

- **Is it working right now?** Events alone can't say. An agent's last edit may be two minutes old because it is thinking, running a long test, waiting for the user's approval, or because the terminal was closed.
- **What is it trying to do?** Not only which files and symbols it touches, but its objective in plain terms: the goal, the current step, and how it is going about it.

Presence is ephemeral state, kept apart from the log. It feeds the log only through reconciliation. An objective left unfinished when a session ends becomes an `open-thread` entry, for example.

### 6.1 Liveness: is the session working now?

Each session has a state:

| State | Meaning |
|---|---|
| `working` | A turn is in progress: the model is generating, or a tool is running |
| `waiting-permission` | Blocked on the user approving a tool call |
| `waiting-user` | The turn finished; the session is open and waiting for the next prompt |
| `idle` | Open, but nothing has happened for a while |
| `ended` | Closed cleanly |
| `gone` | The process disappeared without a clean end: a crash, a closed terminal, a killed container |

Traces alone are not enough, so liveness combines several signal sources. The strongest available one wins, and each state expires on a timeout when its source goes quiet.

| Source | What it gives | Where available |
|---|---|---|
| **Lifecycle hooks** | Exact transitions: `UserPromptSubmit` → working; `PreToolUse`/`PostToolUse` → heartbeat and current tool; `Notification` → waiting for permission or idle; `Stop` → turn finished; `SessionEnd` → ended | Claude Code (all of these); Gemini CLI (similar); others to verify per tool |
| **Trace tailing** | How fast the transcript grows, and what its last record is. A tool call with no result yet means a tool is running; a final assistant message means the turn has ended. Codex logs turn start and end events (`event_msg`). | Every tool whose trace we read |
| **Process probe** | Whether the agent process exists, its working directory (which repo and worktree), CPU use, and child processes. A running `pytest` or `npm test` child means working even with a quiet transcript. Detects `gone`. | Local agents on any OS: `/proc` on Linux, `proc_pidinfo`/`lsof` on macOS, the process API on Windows |
| **Working tree** | Uncommitted changes in the session's worktree: work in flight even while the agent is idle | Any git checkout |
| **Remote agent APIs** | Status of cloud sessions that have no local process | Per provider, through its API or webhooks; later |

This is where Bifröst needs tools beyond the traces:

- a small **hook set** installed per agent tool;
- a **process watcher** in the local daemon;
- later, **connectors** for cloud agents.

Hooks give precise, instant transitions where they exist. The process watcher covers every local agent, including tools without hooks, and is the only way to see a crash. Trace tailing fills in the rest.

**Heartbeat and expiry.** Each signal refreshes the session's state. Without a refresh, a state decays:

- `working` → `idle` after about 2 minutes with no hook, trace growth or busy child process;
- `waiting-user` → `idle` after about 15 minutes;
- `idle` → `ended` after about an hour, or immediately on `SessionEnd`;
- `gone` as soon as the process is missing without an end signal.

The thresholds are parameters to tune.

**Subagents.** Child sessions (Claude Code's Task tool, Codex's multi-agent mode) are linked to their parent. The session-topology code already exists in `src/topology/`. A parent waiting on its subagents counts as `working`.

### 6.2 Objective: what is it trying to do?

An objective is described at three levels:

| Level | Example |
|---|---|
| **Goal**: why the session exists | "Make token refresh safe under concurrent requests" |
| **Step**: what it is doing now | "Adding a lock around `refreshSession`" |
| **Mode**: the kind of work, from the event mix | exploring, implementing, testing, debugging, reviewing, stuck, blocked on user |

Plus two sets of places:

- the **working set**: the places it has touched, from events;
- the **intended set**: the places named in its plan, before it touches them.

**Declared sources come first.** They are free and need no model, because the agent tools already record intent in their traces:

| Source | Gives | Where it comes from |
|---|---|---|
| The prompt that opened the episode | Goal | First user turn, or `UserPromptSubmit`; scrubbed |
| The agent's own plan | Steps; the in-progress item is the current step | Claude Code todo and plan tools (plan mode's approved plan); Codex's plan-update tool calls (steps with status); Cursor todos |
| Session title | Goal summary | Claude Code writes `ai-title` and `custom-title` records to its transcript; Cursor names each composer |
| Git context | Goal hint | Branch name; worktree; linked PR or issue title where a connector is available; commit messages as they land |
| Event mix | Mode | Rules: mostly reads and searches → exploring; edits → implementing; test runs → testing; repeated failures at one place → debugging or stuck; a pending permission → blocked |

**Inference fills the gaps.** When declared signals are missing or vague, the service's models compress them, plus recent scrubbed event digests, into:

- a goal of at most 120 characters;
- a step of at most 80 characters;
- topic tags;
- an **embedding** of the objective.

This runs only when something meaningful changes: a new prompt, a plan update, a new step marked in progress, or the working set moving to a different area of the map. It never runs per event. It is the same tiered approach as classification (§2.4): rules and declared signals first, models only where needed.

**Record:**

```ts
interface Presence {
  session: string; agentSystem: string; parent?: string;       // subagent link
  user: string; machine: string; repo: string; branch?: string; worktree?: string;
  state: "working" | "waiting-permission" | "waiting-user" | "idle" | "ended" | "gone";
  stateSince: string; lastSignal: { source: "hook" | "trace" | "process" | "api"; at: string };
  currentTool?: string;                                         // e.g. "Bash: npm test"
}
interface Objective {
  session: string;
  goal: string; step?: string; approach?: string;
  mode: "exploring" | "implementing" | "testing" | "debugging" | "reviewing" | "stuck" | "blocked";
  topics: string[]; embedding: number[];
  workingSet: Place[]; intendedSet: Place[];
  sources: { kind: "prompt" | "plan" | "title" | "branch" | "pr" | "inferred"; ref: string }[];
  confidence: number; updatedAt: string;
}
```

### 6.3 What presence and objectives are used for

1. **Live lines at a place.** When an agent reaches a place another live session is working on, it sees who is there and why:
   ```text
   LIVE  claude-code · working 4m · debugging   Make token refresh safe under concurrent requests — step: lock around refreshSession
   ```
2. **Overlap before collision.** Live objectives are compared pairwise on two axes:
   - **semantic similarity** of their embeddings;
   - **map proximity**: the same symbols, neighbours on the map, the same area.

   Two sessions scoring high on both are told early, even when neither has touched the other's files yet: "another agent is also changing retry behaviour, in `SessionGuard`". File-level presence can't see this. It is where the semantic objective earns its cost.
3. **Intended places.** A plan that names `SessionGuard` before the agent opens it lets Bifröst warn the *other* session working in `SessionGuard` now, not after the edit.
4. **Session-start orientation.** A new session sees the live objectives in its repo, grouped by area of the map, in two or three lines.
5. **Handoff into the log.** When a session ends or is `gone` with its objective unfinished, the objective, last step and working set go through reconciliation. The usual result is an `open-thread` or `in-progress` entry at those places. The next agent to arrive knows what was being attempted and where it stopped.
6. **Context for entries.** Each log entry keeps the objective of the episode that produced it. "Retry loops on 401s" reads differently when the goal was "make refresh safe under concurrency" than when it was "speed up login".

### 6.4 Visibility and privacy

- Objective text is derived from prompts, so it goes through the same scrubbing as events. It is visible only to the people and agents who share the repository's Bifröst space.
- A user can mark a session private. Its presence then shows as "an agent is working here", with no objective.
- Presence and objectives are not retained as knowledge. They expire with the session, and only what reconciliation writes into the log remains.

### 6.5 To verify

- Which lifecycle hooks Codex and Cursor expose today, and whether they can run a local command on turn start and end.
- How reliably the process probe maps a process to a session when several sessions of one tool run in the same repo. Transcript file handles held open by the process may settle it.
- Cloud agents (Claude Code on the web, Codex cloud and similar): which status APIs or webhooks exist.

---

## 7. Serving the log to agents

### 7.1 Channels by platform

| Platform | Delivered at the place | Session start | Pull (MCP) |
|---|---|---|---|
| Claude Code | `PreToolUse` on `Read\|Edit\|Write\|MultiEdit\|Grep` → `additionalContext` | `SessionStart` hook | Yes |
| Gemini CLI | `BeforeTool` → `additionalContext` | Instruction file | Yes |
| Codex | Not possible: Codex Desktop rejects `additionalContext` on `PreToolUse` | `AGENTS.md` | Yes |
| Cursor | Not possible | `.cursor/rules` (`alwaysApply`) | Yes |

These are the channels Graphify already relies on. Its hooks inject a fixed reminder, while Bifröst injects the entries for the place being touched.

### 7.2 Latency

- A tiny hook shim talks to a warm local daemon over a socket, with a 30 ms p95 budget.
- The daemon serves from a local replica of the log for this repository. The service pushes updates to that replica; it is not queried on the hot path.
- If the daemon doesn't answer in time, the shim prints nothing and never blocks the agent.

For comparison, Graphify's guard starts a new process per call (65 ms here) and carries no content.

### 7.3 What the agent sees

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

### 7.4 Pull tools and corrections

| Tool | Purpose |
|---|---|
| `bifrost.at(path, symbol?)` | The entries for a place, with a larger budget |
| `bifrost.where(topic)` | Places where the log has entries on a topic. Returns places, not transcripts. |
| `bifrost.confirm(id)`, `bifrost.dispute(id, reason?)`, `bifrost.correct(id, text)` | Correction events into §3 |

---

## 8. Deployment boundary

| Runs locally | Runs in the service |
|---|---|
| Harness and git adapters | Tier-2 classification on open-weight models |
| Normalization and scrubbing | Reconciliation questions the rules can't settle |
| Placement on the map (reads `graph.json`) | The shared log for teams and machines, and sync |
| Tier-1 rules, activity | Objective inference when declared signals fall short |
| Liveness: lifecycle hooks, trace tailing, process watcher | Presence relay between machines and team members (ephemeral, not stored) |
| Declared objectives (prompt, plan, title, branch) | Overlap detection across live sessions |
| Local replica of the log, daemon, hook shim | Metering |

- **What crosses the boundary:** scrubbed episode digests going up (commands, error signatures, hunk headers, placed symbols, short excerpts of intent), and log entries coming down.
- **What stays local:** raw transcripts. The service holds no episode content after classification. That is the no-retention contract in the architecture doc.
- **What the user's model does:** nothing. Bifröst never spends the user's LLM tokens to build or maintain the log. Their agents only read it, plus the occasional correction.

---

## 9. What to build first

The upper-bound experiment still comes first. It uses **hand-written** entries to test whether delivery at the place helps at all. If that passes, the pipeline is built in this order:

1. Graphify adapter, and placement of events from the Claude Code and Codex adapters. Measure how many edit and test events resolve to a symbol.
2. Episode segmentation and tier-1 rules. Measure how many real sessions yield a candidate, and how many of those a person judges worth keeping.
3. Reconciliation with rules only: revert, fix and duplicate handling.
4. Tier-2 classification on a hosted open-weight model, over candidates only. Measure cost per session.
5. Daemon, local replica, and the Claude Code `PreToolUse` shim, within the 30 ms budget.
6. Liveness: Claude Code lifecycle hooks, trace tailing, and the process watcher. Check the state machine against real sessions, including killed terminals.
7. Declared objectives from prompts, plans and titles. Then inference where they are missing, and overlap detection between live sessions. Measure how often overlap alerts are correct before showing them to agents.
