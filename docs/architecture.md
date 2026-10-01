# Bifröst

**A persistent, realtime work layer for agentic software development**
*Architecture & product concept*

> **Core thesis:** Agents should encounter the relevant history of work at the
> place where they are working, rather than being expected to stop and search for it.

## 1. Executive Summary

Modern software work is increasingly distributed across Claude, Codex, Cursor,
subagents, and multiple sessions operating on the same repository. Each tool
maintains its own local context, while the codebase remains the shared physical
object. The result is a coordination gap: agents repeat failed approaches,
decisions disappear into transcripts, and it becomes difficult to understand
where work is happening or what has already been learned.

Bifröst is a standalone system designed to close that gap. It sits on top
of a structural map of the codebase and maintains a realtime, temporal layer of
work context anchored to code locations. The system records mechanical activity,
live presence, compact typed findings, and task state. Context is delivered by
place: when an agent enters or touches a relevant area, the system can surface a
small amount of newly relevant information without requiring the agent to
explicitly perform a search.

The design deliberately separates the code map from the work layer. The map is a
replaceable representation of code structure; the work layer is the persistent
record of activity and knowledge that evolves against that structure. Anchors use
repository-native references such as path, symbol, line span, and commit rather
than ephemeral graph node IDs, allowing the work layer to survive map rebuilds and
to reference code the graph has not yet indexed.

> **Mental model:** The code map is the road map. Bifröst is the traffic,
> traces, warnings, active vehicles, and recent events moving across it.

```text
                          BIFRÖST
       ┌─────────────────────────────────────┐
       │ activity   presence   findings      │
       │ tasks      trails     timelines     │
       └──────────────────┬──────────────────┘
                          │ anchored to
                          ▼
       ┌─────────────────────────────────────┐
       │             CODE MAP                │
       │ files · symbols · calls · regions   │
       └─────────────────────────────────────┘
```

## 2. Problem

### 2.1 Parallel work without shared context

Agents increasingly work in parallel across different interfaces and sessions.
Claude, Codex, Cursor, custom agents, and subagents may all operate on the same
codebase, but their context windows and task histories are isolated. Information
discovered in one session does not reliably appear when another agent reaches the
same code.

- **Repeated traps:** an agent reproduces an approach that another agent already tried and found to fail.
- **Lost decisions:** architectural choices remain buried in conversation history instead of being attached to the code they govern.
- **Invisible work:** it is difficult to know what areas are actively being investigated, changed, or blocked.
- **Poor handoff:** a later agent sees files and diffs, but not necessarily why they changed or what was learned while changing them.

### 2.2 Why search-at-task-time is insufficient

A conventional history-search system assumes an agent will recognize that it
lacks context, formulate a useful query, invoke a search tool, inspect the
results, and integrate the results into its current task. In practice, that
introduces a behavioral dependency on the agent itself. The system is most useful
precisely when the agent does not know what it does not know.

Raw transcripts also contain too much noise. Tool calls, repeated explanations,
shell output, retries, intermediate reasoning, and unrelated conversation make
transcript-level retrieval an awkward primary representation for operational
context.

> **Design response:** Do not make historical context something the agent has to
> go looking for. Attach compact, typed work information to the places where the
> agent is already operating.

## 3. Core Concept

### 3.1 Two maps, superimposed

The architecture consists of two independent but co-located layers.

| Layer | Purpose | Examples | Lifecycle |
|---|---|---|---|
| Base map | Represent the structure of the codebase. | Files, symbols, imports, calls, regions. | Snapshot; rebuilt periodically. |
| Bifröst (work layer) | Represent what agents are doing and learning about that structure. | Activity, presence, findings, tasks, trails, timelines. | Continuous; evolves in realtime. |

The map provides topology; Bifröst provides operational context. Neither
should be forced to own the other's concerns.

### 3.2 Views are projections of one layer

Notes, heatmaps, agent presence, activity trails, timelines, and map annotations
are not separate memory systems. They are views over the same underlying Bifröst.

```text
Bifröst state
      │
      ├── Notes / findings view
      ├── Activity heatmap
      ├── Live presence view
      ├── Work trails
      ├── Timeline / history
      └── Map-attached context
```

## 4. What Lives in Bifröst

Bifröst intentionally distinguishes mechanical telemetry from semantic
knowledge and live state. This prevents every event from becoming a "memory."

### 4.1 Activity — mechanical history

Activity answers: *"What happened here?"* It should capture work regardless of
which interface caused it.

- Read, search, edit, create, delete, rename, run, test, inspect, discuss.
- Shell-level file touches and commands, not just high-level edit tools.
- Agent/session identity, source tool, timestamp, target anchor, and outcome where known.

Activity is high-volume substrate. It can support timelines, heatmaps,
reconstruction, and later extraction, but it is not normally surfaced directly to
every agent.

### 4.2 Presence — live state

Presence answers: *"Who or what is active here right now?"* It is intentionally
ephemeral and seconds-fresh.

| Field | Example |
|---|---|
| Agent/session | Codex session 17 |
| Location | `src/auth/refresh.ts → refreshSession()` |
| Objective | Goal: make token refresh safe under concurrent requests; step: lock around `refreshSession` |
| Mode | debugging |
| State | working (or waiting-permission, waiting-user, idle, ended, gone) |
| Updated | seconds ago |

Whether a session is working *now* can't be read from events alone. It combines
lifecycle hooks, transcript tailing, a local process watcher and, for cloud
agents, provider APIs. The objective is taken from what the agent tools already
record (the opening prompt, the agent's own plan and todos, the session title,
the branch), with inference only where those are missing. Live objectives are
compared by meaning and by map proximity, to warn about overlapping work before
it collides. Details: [`study/bifrost-on-maps.md`](./study/bifrost-on-maps.md) §6.

### 4.3 Findings — compact semantic knowledge

Findings answer: *"What was learned or decided?"* They are typed, short,
anchored, and intended to be useful in-context.

| Type | Purpose |
|---|---|
| `decision` | A choice that should influence later work. |
| `discovery` | A newly established fact about the code or system. |
| `warning` | A condition or trap that later work should avoid. |
| `known-issue` | A problem already observed and characterized. |
| `how-to` | A concise procedure that has been demonstrated to work. |
| `in-progress` | A line of investigation or implementation currently underway. |
| `open-thread` | A question or unresolved issue that remains relevant. |
| `preference` | A convention the user or team wants followed that cannot be derived from the code, usually learned from a correction. |

Default finding content is at most 280 characters, with optional "why" context
and a link back to the originating thread. The short form is deliberate: the Work
Layer should provide orientation, not replay a conversation.

### 4.4 What earns a place on the plane

Bifröst does not hold everything. It holds what is judged important enough to
share between agents, and every item is classified by type. The granularity and
the set of types stay modular, so new kinds of knowledge can be added without
reshaping the store.

The upper-bound experiment (section 13.5) sharpened what is worth admitting:

- **Taste is not in the code.** Many decisions are not logical consequences of
  the code; they are how the user or team wants things done (a delimiter, a
  naming style, an export convention). No amount of searching recovers them.
  These become `preference` items.
- **Capable agents still get things wrong.** A strong model with enough time
  does not always find the answer, and the user has to step in. Each such
  correction is knowledge that exists only in past work, and is the highest-value
  input to the plane.
- **Smaller, cheaper and lower-effort agents gain the most.** A strong model at
  high reasoning effort often recovers facts that are written down somewhere in
  the repository. Smaller models and low-effort modes do so less often, so the
  same item is worth more to them.
- **Findable facts are worth less, not nothing.** When the knowledge is in the
  repository and one search finds it, an item adds little. Admission should
  favor what is absent from the code or costly to find.

The plane serves agents analysing their own work too. While reviewing these
experiments, an agent concluded that notes matter little when a search can find
the answer; the user added the four points above. That exchange is itself the
kind of item the plane should keep: an agent's conclusion, corrected and
extended by a person, anchored to the work it concerns, so the next agent starts
from the corrected version.

### 4.5 Tasks — work with state

Tasks represent explicit work requests and their resulting state. Unlike
findings, tasks are inherently stateful.

| Task state | Meaning |
|---|---|
| `verified` | The requested work has been confirmed to work. |
| `failing` | The work is currently known to fail. |
| `unverified` | Work exists but correctness has not been established. |
| `reverted` | The attempted change was backed out or superseded. |

## 5. Anchoring and Temporal Semantics

### 5.1 Anchors are neutral

Work items are not permanently bound to internal IDs from the code graph. Anchors
identify code using repository-native references that remain meaningful across
map rebuilds and can also point to code that the map does not yet know about.

```text
anchor = {
  repository,
  path,
  symbol?,
  lineStart?,
  lineEnd?,
  commit?
}
```

This lets Bifröst remain useful even when the underlying structural map is
rebuilt, incomplete, or temporarily stale.

### 5.2 Every item has time semantics

A finding is not an eternal truth. It is a claim that was valid under a
particular state of the repository and may later be superseded.

```text
validFrom
validUntil?
supersededBy?
source
confidence
votes
```

A later finding of the same type on the same anchor can replace an earlier one.
When anchored code changes, a finding can be marked potentially stale rather than
silently presented as current.

> **Integrity principle:** A wrong or misleading note is worse than no note. The
> lifecycle therefore needs explicit mechanisms for replacement, staleness,
> correction, and negative feedback.

## 6. Delivery: Context by Place, Not Search

The primary product behavior is contextual delivery. Bifröst should
surface information because an agent arrived at a relevant location, not because
the agent remembered to perform a search.

### 6.1 File-touch trigger

```text
Agent touches src/auth/refresh.ts
            │
            ▼
Resolve anchor
            │
            ▼
Find recent / relevant work items
            │
            ├── no useful new context → silence
            │
            └── useful context → inject top 2–3 items
                                    (~150 tokens max)
```

Silence is a first-class outcome. The system should not create notification
fatigue by surfacing repetitive or low-value context.

Delivered context must also read as trusted. Agents are trained to distrust
instructions that appear inside tool output, because prompt injections arrive
that way. In the experiment, a strong model shown correct notes inside file reads
ignored them in half the runs. Each delivery channel should therefore establish,
through the agent's system prompt or equivalent, what Bifröst items are and that
they come from the team's own tooling.

### 6.2 Session start

At session start, the system can provide a concise "where the work is"
orientation for the current repository: active areas, recent tasks, notable
findings, and relevant live agents. This establishes situational awareness before
the agent begins modifying code.

### 6.3 Map queries

When a user or agent opens a code-map node, the node can be returned together
with the relevant Bifröst items. This makes the work context part of
navigating the codebase rather than a separate research activity.

### 6.4 `where(topic)`

A semantic "where" query should return places, not transcripts. For example,
"where are we still having refresh-token issues?" should identify relevant files,
symbols, regions, or tasks, with their attached findings and status.

## 7. Agent Interaction Model

Bifröst is principally an informant. It should make relevant work visible
without taking control away from the agent.

| Interaction | Default behavior |
|---|---|
| Surface finding | Inform only; do not block the task. |
| Correct finding | Agent may confirm or vote up. |
| Wrong/stale finding | Agent may downvote, correct, or supersede. |
| Agent creates finding | Persist typed finding with source and anchor. |
| Conflicting finding | Expose the conflict; do not silently lock behavior. |
| Task state update | Allow later work to verify, fail, revert, or supersede. |

> **Non-blocking principle:** Bifröst should inform by default. It is
> contextual infrastructure, not an autonomous gatekeeper.

## 8. How Knowledge Enters the Layer

Bifröst is built and maintained by the service from agents' work history. It
does not rely on agents choosing to write to it, and it never uses the user's
own model or tokens.

1. **Streamline.** The traces agent tools already write (Claude Code, Codex,
   Cursor and others) and git history are read locally and normalized into a
   stream of typed work events: reads, edits, commands, tests, commits,
   reverts. They are scrubbed before anything leaves the machine.
2. **Place.** Each event is resolved to places on the system map.
3. **Classify.** Events are grouped into episodes, one attempt at one thing.
   Cheap rules classify first (struggles, fixes, reverts, verified work,
   unfinished work, decision language). Hosted open-weight models handle only
   the candidates the rules flag.
4. **Reconcile.** Each classified episode is compared with the entries already
   at its places, and either **adds** an entry, **updates** one (reinforce,
   refine, change task state, supersede), or is **dismissed**.
5. **Re-validate.** Later work, code changes and reverts flow through the same
   pipeline, so entries are confirmed, flagged stale or superseded without
   manual curation.

| Path | Role |
|---|---|
| Work-history pipeline (above) | Primary. Builds and updates the layer continuously. |
| Agent corrections (confirm, dispute, correct) | Secondary. Enter the reconciliation step as high-trust events. |

Extraction is constrained to the structured finding schema. Raw transcripts
stay on the user's machine. The service keeps no episode content after
classification, and full transcripts are never the user-facing representation.

The detailed design is in [`study/bifrost-on-maps.md`](./study/bifrost-on-maps.md).

## 9. Lifecycle and Decay

1. **Create:** a finding, task state, or activity event is written with an anchor, source, time interval, and confidence.
2. **Surface:** relevant recent items are delivered when an agent reaches an applicable place.
3. **Validate:** later work can implicitly or explicitly confirm the item.
4. **Correct:** agents can vote down or replace an item that is misleading.
5. **Supersede:** a newer finding of the same type can replace the previous one.
6. **Stale:** code changes can mark an item as requiring revalidation.
7. **Retain or decay:** old activity remains useful for reconstruction; semantic findings should remain visible only while their validity warrants it.

This creates a temporal layer rather than a static "memory database." The system
remembers not only what was said, but when it was true and what later work did to
that belief.

## 10. System Architecture

A reference architecture can remain small and local-first. The major components
are separable so that Bifröst can exist independently of any particular
code graph implementation or agent provider.

```text
                   ┌──────────────────────────┐
                   │        Agent tools       │
                   │ Claude / Codex / Cursor  │
                   │ subagents / shell / IDE  │
                   └────────────┬─────────────┘
                                │ events / queries
                                ▼
                   ┌──────────────────────────┐
                   │       Bifröst API        │
                   │ ingest · resolve · read  │
                   └───────┬─────────┬────────┘
                           │         │
              ┌────────────▼─┐   ┌───▼───────────────┐
              │ Work Store   │   │ Context Engine    │
              │ activity     │   │ place resolution  │
              │ findings     │   │ recency / status  │
              │ presence     │   │ surfacing rules   │
              │ tasks        │   └──────────┬────────┘
              └──────────────┘              │
                                            ▼
                                 ┌────────────────────┐
                                 │       Agent        │
                                 │ contextual context │
                                 └────────────────────┘
                                            ▲
                                            │
                         ┌──────────────────┴─────────────┐
                         │ Base Code Map / Graph          │
                         │ files · symbols · relations    │
                         └────────────────────────────────┘
```

### 10.1 Local-first deployment

For the initial product, Bifröst and its store can live on the
developer's machine. The system can observe local agents, shells, and repository
activity without requiring a remote dependency for core operation.

### 10.2 Hosted model work

A paid service can provide model-backed extraction or embedding work using hosted
open-weight models. The intended contract is scrubbed processing, no retained
customer content, and metered model usage. The local store remains the source of
the user-facing operational context.

### 10.3 Syncable store

A syncable representation can later support multi-machine workflows and cloud
agents. This is an extension of the same Bifröst model, not a requirement for
proving the core interaction.

## 11. Product and Business Boundary

The initial customer is a single developer who runs many agents or sessions on a
local codebase. The primary value is reduced duplicated work and better
situational awareness.

| Core product | Optional service |
|---|---|
| Local Bifröst store | Hosted extraction |
| Place-based delivery | Hosted embeddings |
| Local agent/tool integration | Metered model execution |
| Presence and activity | Cloud sync |
| Code-map integration | Future multi-machine / cloud-agent support |

This boundary keeps the product valuable without requiring users to upload their
entire development history to a hosted memory service.

## 12. Non-Goals

- Not a replacement for an agent's normal task context window.
- Not a transcript archive presented as "memory."
- Not a search engine that expects agents to invoke it for every question.
- Not a hard authorization or workflow gate that prevents agents from acting.
- Not a requirement to index every byte of history into embeddings.
- Not initially a distributed cloud coordination platform.

## 13. Initial Experiment / MVP

The first experiment should test the value of place-triggered context before
building sophisticated extraction, retrieval, or ranking infrastructure.

### 13.1 Upper-bound experiment

Hand-write perfect findings for a small repository. Treat the findings as an
upper bound on what an ideal extractor could provide. If perfectly authored,
correctly anchored context does not materially improve downstream agent
performance, no extraction system can rescue the core hypothesis.

### 13.2 Minimal system

- One repository and a small number of concurrent agents.
- A base map sufficient to identify files and optionally symbols.
- A local Bifröst store.
- Manually authored findings.
- Presence state.
- A file-touch trigger that injects relevant findings.
- A small set of deliberately constructed "trap tasks" where previous work contains useful warnings or decisions.

### 13.3 Comparison

| Condition A | Condition B |
|---|---|
| Agent receives normal repository state and task context. | Same, plus correct Bifröst context delivered at relevant places. |
| No place-triggered finding. | Top 2–3 relevant findings, bounded to ~150 tokens. |

### 13.4 Success criteria

The initial threshold is deliberately demanding: the place-triggered system should
make agents at least 15% faster or cheaper, or materially improve completion of
trap tasks, relative to the baseline. If it fails under perfect-note conditions,
stop the project. If it succeeds, introduce extraction and automation
incrementally.

| Metric | What it tests |
|---|---|
| Time to completion | Whether context reduces investigation/rework time. |
| Tool-call count | Whether context reduces redundant exploration. |
| Token / model cost | Whether context reduces expensive reasoning/search. |
| Trap-task success | Whether the system prevents previously observed mistakes. |
| Regression / repeated failure rate | Whether warnings and decisions persist across sessions. |

### 13.5 First results

Free models through OpenCode; full tables in `experiments/upper-bound/README.md`.

- **Knowledge absent from the repository** (an undocumented vendor change, a
  team's conventions): without notes, agents failed in every run; with correct
  notes, small models almost always passed.
- **Knowledge present in the repository**, even as one section among ~186 files:
  both models found it by searching, and notes added no measurable benefit.
- **Wrong notes** were followed whenever the repository did not contradict them,
  and overridden when it did. Admission and correction matter as much as
  delivery.
- **Delivery channel:** a strong model ignored correct notes pushed into tool
  output in half the runs. Early runs that also explain the notes in the system
  prompt pass; a pull tool the agent must call was used only for some files.

## 14. Open Questions

- How precisely should an event be mapped to an anchor when shell activity or generated changes touch many files?
- What is the smallest finding schema that is useful without becoming rigid?
- How should conflicts between findings be displayed when two agents disagree?
- How should code changes determine whether an old finding is stale versus still applicable?
- What should count as "new" enough to surface, especially when an agent revisits the same area repeatedly?
- How should presence expire when an agent crashes, disconnects, or becomes idle?
- When should activity be summarized into findings automatically, and when should raw activity remain untouched?
- How much semantic understanding is actually needed for place resolution before embeddings or an LLM become necessary?
- How is "important enough to share" judged at admission, and how does a correction from the user outrank an agent's own finding?
- How does each agent client establish that delivered items are trusted, without that trust becoming an injection route of its own?

## 15. Design Principles

| Principle | Implication |
|---|---|
| Context should arrive where work happens. | Prefer place-triggered delivery over search-first interaction. |
| Knowledge has a location and a time. | Every semantic item is anchored and temporal. |
| Telemetry is not memory. | Keep activity separate from findings. |
| Silence is useful. | Do not surface context unless it is new and relevant. |
| Wrong context is harmful. | Support correction, votes, supersession, and staleness; agents follow uncontradicted notes. |
| Admit what the code cannot tell. | Prioritize preferences, corrections and knowledge absent from the repository over findable facts. |
| Delivered context must read as trusted. | Explain the channel to the agent; text appended to tool output alone is often ignored. |
| Inform before controlling. | Default behavior is non-blocking. |
| The map is replaceable. | Do not make work data depend on graph-specific node IDs. |
| Test the value before the machinery. | Use perfect-note upper-bound experiments before building extraction pipelines. |
| Local-first reduces trust and cost barriers. | Keep the core store close to the developer; make hosted model work optional. |

## 16. Closing Model

Bifröst is best understood as a persistent operational layer over a living
codebase. The code map describes the structure. Bifröst records the work
that moves through that structure: who was there, what they touched, what they
learned, what they decided, what remains unresolved, and what has since changed.

Its defining behavior is not retrieval. It is contextual delivery. The system
should make the right small piece of history appear at the right place and time,
without requiring an agent to know that a memory system exists.

> **One-sentence architecture:** A local-first, temporal, multi-agent work layer
> anchored to code locations and delivered contextually as agents move through
> the codebase.

*Status: standalone working architecture document. This document describes the
current concept and experimental boundary; implementation details remain
intentionally open where the upper-bound test has not yet established value.*
