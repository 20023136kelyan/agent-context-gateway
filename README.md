# Work Layer

**A local-first, temporal, multi-agent work layer anchored to code locations and
delivered contextually as agents move through the codebase.**

Agents should find the relevant history of work at the place where they are
working, instead of having to stop and search for it. When an agent touches
`src/auth/refresh.ts`, it should learn, in two or three short lines, that another
session already tried the obvious fix and why it failed. It should not need to
know that a memory system exists.

Full concept: [`docs/work-layer-architecture.md`](./docs/work-layer-architecture.md).

> **Branch note.** This branch starts the Work Layer direction. `main` holds the
> previous approach, the Agent Context Gateway (federated search over native
> agent histories), and its README, spec and plans remain in this tree for
> reference until they are retired or reused.

## Status: pre-MVP

Nothing here is built yet. The first milestone is the **upper-bound experiment**
(§13 of the architecture doc). Its question is whether perfect, hand-written,
correctly anchored findings delivered at the right place make agents
materially better. If they don't, no extraction pipeline can rescue the idea,
and the project stops.

- [ ] Pick one small repository and design a set of *trap tasks*, where earlier
      work holds a warning or decision that a fresh agent would otherwise miss
- [ ] Hand-author findings for it (typed, anchored, ≤ 280 chars)
- [ ] Local Work Layer store: findings, presence, activity
- [ ] File-touch trigger that injects the top 2–3 relevant findings (~150 tokens max), or stays silent
- [ ] A/B harness: baseline agent vs. the same agent with place-triggered findings
- [ ] Decide: ≥ 15% faster or cheaper, or materially better trap-task completion, or stop

## The model

Two layers, kept separate:

```text
                         WORK LAYER
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

The code map is the road map. The Work Layer is the traffic, traces, warnings
and recent events moving across it.

| Kind | Answers | Character |
|---|---|---|
| **Activity** | What happened here? | Mechanical and high-volume: reads, edits, runs, tests, shell touches. Substrate, not memory. |
| **Presence** | Who is active here right now? | Ephemeral, updated within seconds. |
| **Findings** | What was learned or decided? | Typed (`decision`, `discovery`, `warning`, `known-issue`, `how-to`, `in-progress`, `open-thread`), ≤ 280 chars, links back to the originating thread. |
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

| Path | Strength | Trade-off |
|---|---|---|
| Session-end note by the agent | Cheapest, highest local context | Depends on agent cooperation |
| Offline extraction over a finished task | No special behavior needed | May miss implicit knowledge |
| Agent-authored correction or vote | Continuous maintenance | Needs good UX and trust signals |

Extraction is scrubbed and constrained to the finding schema. Full transcripts
are never the user-facing representation.

## Deployment boundary

**Core (local):** Work Layer store, place-based delivery, agent/tool integration,
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

## Inherited from the gateway

The Agent Context Gateway code in `src/` stays in place. It is not the
product on this branch. Parts of it may serve the Work Layer, but each is
unproven here and stays unused until the experiment calls for it:

| Gateway piece | Possible Work Layer role |
|---|---|
| `src/adapters/` (Claude Code, Codex, Cursor, OpenCode, git) | Activity capture and offline extraction input |
| `src/temporal/` (bi-temporal invalidation, `asOf`) | Supersession and validity intervals for findings |
| `src/feedback/` | Votes on findings |
| `src/collaboration/live.ts` | Starting point for presence |
| `src/artifacts/graph.ts` | A rough file-level code map |
| `src/transports/mcp.ts`, `src/git/hooks.ts`, session hooks | Integration points for triggers and ingestion |

Running the existing gateway: `npm install && npx tsx src/cli.ts --help`.
