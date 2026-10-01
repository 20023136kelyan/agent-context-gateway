# Bifröst

**A local-first, temporal, multi-agent work layer anchored to code locations and
delivered contextually as agents move through the codebase.**

Agents should find the relevant history of work at the place where they are
working, instead of having to stop and search for it. When an agent touches
`src/auth/refresh.ts`, it should learn, in two or three short lines, that another
session already tried the obvious fix and why it failed. It should not need to
know that a memory system exists.

Full concept: [`docs/architecture.md`](./docs/architecture.md).

> **Branch note.** This branch is the new direction for Bifröst. `main` holds
> the previous approach (federated search over native agent histories,
> originally named Agent Context Gateway); its code, spec and plans remain in
> this tree for reference until they are retired or reused.

## Status: experiments done, build planned

None of the product is built yet. The **upper-bound experiment** (§13 of the
architecture doc) asked whether short, correctly anchored notes delivered at the
place make agents materially better. For knowledge the code cannot tell
(preferences, corrections, undocumented behaviour) they do: agents went from
failing every run to passing nearly every run, once the notes were pushed at the
place and explained in the agent's session context. Results, and the failure
modes found along the way (wrong notes, noise, generated advice from failed
sessions), are in [`experiments/upper-bound/`](./experiments/upper-bound/README.md)
and architecture §13.5–13.6.

Next: the [build plan](./docs/build-plan.md).

- [x] Experiment kit: trap tasks with hidden graders, push and pull delivery, notes generator, A/B harness and report
- [x] Runners for Claude Code and OpenCode; runs on free models through OpenCode
- [x] Trap tasks across kinds of knowledge: undocumented vendor change, team taste, findable vendor fact
- [x] Control vs notes, ≥ 10 runs per arm on a strong model; small models and low reasoning effort
- [x] Delivery channel (push, pull, explained push), folder anchors, generated notes, noise
- [x] Decision against the bar: met for unfindable knowledge (0% → 100%); no gain where one search finds the answer
- [ ] Build version 1 ([plan](./docs/build-plan.md))

## The model

Two layers, kept separate:

```text
                          BIFRÖST
       ┌─────────────────────────────────────┐
       │ activity   presence   findings      │   continuous, realtime
       │ tasks      trails     timelines     │
       └──────────────────┬──────────────────┘
                          │ anchored to
                          ▼
       ┌─────────────────────────────────────┐
       │             CODE MAP                │   snapshot, replaceable
       │ files · symbols · calls · regions   │
       └─────────────────────────────────────┘
```

The code map is the road map. Bifröst is the traffic, traces, warnings
and recent events moving across it.

| Kind | Answers | Character |
|---|---|---|
| **Activity** | What happened here? | Mechanical and high-volume: reads, edits, runs, tests, shell touches. Substrate, not memory. |
| **Presence** | Who is active here right now? | Ephemeral, updated within seconds. |
| **Findings** | What was learned or decided? | Typed (`decision`, `preference`, `discovery`, `warning`, `known-issue`, `how-to`, `in-progress`, `open-thread`), ≤ 280 chars, links back to the originating thread. |
| **Tasks** | What state is the work in? | `verified`, `failing`, `unverified`, `reverted`. |

**Anchors are repository-native** (`repository, path, symbol?, lineStart?,
lineEnd?, commit?`) rather than graph node IDs, so work survives map rebuilds and
can point at code the map hasn't indexed.

**Every item is temporal** (`validFrom`, `validUntil?`, `supersededBy?`,
`source`, `confidence`, `votes`). Findings can be superseded, voted down, or
marked stale when their anchored code changes. A wrong note is worse than no note.

## Delivery: by place, not by search

- **File touch:** resolve the anchor, find new and relevant items, then either
  inject the top 2–3 or stay silent. Silence is a first-class outcome.
- **Session start:** a short "where the work is" orientation covering active
  areas, recent tasks, notable findings and live agents.
- **Map queries:** a code-map node comes back with its attached work items.
- **`where(topic)`:** returns *places* (files, symbols, tasks with their
  findings), not transcripts.

The layer informs and never blocks. Agents can confirm, downvote, correct or
supersede what they're shown.

## How knowledge gets in

Bifröst is built by the service from agents' work history. Agents don't have
to write anything, and the user's own model is never used to maintain it.

```text
agent traces + git ─► events (scrubbed, local) ─► placed on the map ─► episodes
  ─► classified (rules first, hosted models for flagged candidates)
  ─► reconciled against the log: add · update · supersede · dismiss
```

Agents can confirm, dispute or correct what they are shown. Those corrections
go through the same reconciliation step and are a secondary channel. Raw
transcripts stay local, and the service keeps no episode content after
classification. Design: [`docs/study/bifrost-on-maps.md`](./docs/study/bifrost-on-maps.md).

## Deployment boundary

**Core (local):** Bifröst store, place-based delivery, agent/tool integration,
presence and activity, code-map integration. Nothing needs a remote dependency.

**Optional service:** hosted extraction and embeddings on open-weight models
(scrubbed, no retained content, metered), plus cloud sync later.

## Non-goals

Not a replacement for the agent's context window. Not a transcript archive
presented as memory. Not a search engine agents must remember to call. Not a
workflow gate. Not "embed every byte". Not, initially, a distributed cloud
coordination platform.

## Open questions

See §14 of the architecture doc: event-to-anchor precision for shell activity,
the smallest useful finding schema, conflict display, staleness detection, what
counts as "new", presence expiry, when to summarize activity into findings, and
how much semantics place resolution really needs.

## Code

| Path | What it is |
|---|---|
| `src/adapters/` | Read-only readers of native agent histories: Claude Code, Codex, Cursor, OpenCode, git. Input to ingestion (build plan M2). |
| `src/core/`, `src/topology/` | Shared models and ids; parent/child session topology. |
| `experiments/upper-bound/` | The experiment kit: trap tasks, delivery hook and plugin, notes generator, harness. |

The previous approach (federated search over agent histories, first named Agent
Context Gateway) was retired from this branch in build-plan M0. Its full code,
tests, scripts, UI and documents are at commit `2d7285c` and on `main`. Pieces worth
reading before rebuilding their equivalents: `src/temporal/` (bi-temporal
validity), `src/feedback/` (votes), `src/collaboration/live.ts` (presence),
`src/git/hooks.ts` (git integration).

```sh
npm install
npm test
```
