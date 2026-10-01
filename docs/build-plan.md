# Bifröst build plan

From the experiments to a first version a developer uses every day. The concept
is in [`architecture.md`](./architecture.md), the pipeline design in
[`study/bifrost-on-maps.md`](./study/bifrost-on-maps.md), and the evidence in
[`experiments/upper-bound/README.md`](../experiments/upper-bound/README.md).

## 1. What version 1 is

One developer, one or more repositories, several agents (OpenCode, Claude Code,
Codex, Cursor) working on them. Bifröst runs locally, learns from the agents' own
work history and the developer's corrections, and puts short notes in front of
each agent at the place it is working. Model work (classification, extraction)
runs in the service on hosted open-weight models, never on the user's model or
tokens.

Version 1 succeeds when, on the developer's real repositories:

- a correction or preference the developer gave once reaches later agents without
  being repeated, and they follow it;
- the notes shown are ones the developer would keep (precision measured, §6);
- delivery adds no noticeable latency (under 30 ms per tool call).

Out of scope for version 1: teams and sync, cloud agents, overlap alerts between
live sessions, a web UI beyond a minimal review screen.

## 2. Requirements the experiments settled

Each of these is a design decision now, not an open question.

| Requirement | Evidence |
|---|---|
| Admit knowledge the code cannot tell: preferences, corrections, decisions, undocumented external behaviour. Findable facts are low priority. | Unfindable tasks: 0% → 100% with notes; findable vendor task: no gain. Real session: 19 of 49 user messages carried such knowledge, 18 of them not findable. |
| Push notes at the place; do not rely on the agent asking. | Pull tool: 20%; push: 50%; explained push: 100% (strong model, taste task). |
| Explain the notes in the agent's system or session context. | Plain push ignored half the time by a strong model; explained push 35/35 across models and effort levels. |
| Anchors can be files, symbols, folders or the project. A note about a new file belongs to its folder. | Folder anchors reached an agent that never opened the old files: conventions followed went from ~1 in 5 to 5 in 5. |
| Extraction records only what an outcome confirms. | A generator turned a failed session's approach into advice: 0/5. A generator that did not: 4/5. |
| Ranking weighs relevance to the current action, and admission keeps noise out. | Three irrelevant notes filled the per-touch cap and hid a correct one; the agent broke exactly that convention. |
| Wrong notes are followed when nothing contradicts them; correction and supersession are core. | Misleading notes: 0% on unfindable tasks. |
| A cheap hosted model is enough for extraction. | MiMo-class notes matched a strong model's on taste and beat it on the undocumented task. |
| Every major client can carry this delivery. | Claude Code and Gemini CLI inject before a tool call; Codex, Cursor and OpenCode after it; all have a session-start channel (study §7.1). |

## 3. Shape of the system

```text
 agent clients ──hooks/plugins──▶ local daemon ◀── CLI (notes, review, status)
 (OpenCode, Claude Code,             │   ▲
  Codex, Cursor)                     │   │ notes for a place (< 30 ms)
                                     ▼   │
 native traces + git ──adapters──▶ events ──▶ episodes ──▶ candidates
                                     │                         │
                              local store                scrubbed digests
                       (items, anchors, evidence,               │
                        activity, presence)                     ▼
                                     ▲                 service: hosted model
                                     └──── items (add / update / dismiss) ◀┘
```

- **Local:** adapters, scrubbing, placement on the code map, episodes and rule
  classification, the store, the daemon, the client shims, the CLI.
- **Service:** extraction and reconciliation questions on hosted open-weight
  models, over scrubbed digests only, with no retention after processing.
- **Code map:** Graphify when present; without one, anchors fall back to paths
  and folders from the repository itself, so Bifröst works on day one.

## 4. Milestones

Each milestone ends in something the developer uses, and in a measurement.
Estimates assume one developer working with agents, in weeks of focused work.

### M0. Foundations (1 week)

- Move the previous approach's code (search, indexing, embeddings, remotes) out
  of the way; keep the harness adapters (`src/adapters/`), git hooks and session
  topology, which the pipeline reuses.
- Store schema: items with type (`warning`, `known-issue`, `decision`,
  `preference`, `discovery`, `how-to`, `in-progress`, `open-thread`), text
  (≤ 280 chars), anchor (project, folder, file, symbol, lines), evidence
  (sessions, outcomes, the user message it came from), source, confidence,
  validity (`validFrom`, `validUntil`, `supersededBy`), votes.
- SQLite store in the repository's `.bifrost/` or the user's data directory;
  migrations from day one.
- Port the experiment kit's tested pieces: note matching (folder anchors), path
  extraction from tool calls, sanitising, formatting.

**Done when** the store round-trips items and the kit's matching tests pass
against it.

### M1. Delivery, with notes written by hand (2 weeks)

The experiments showed delivery alone is worth having: notes the developer
writes are followed. This milestone makes Bifröst useful before any extraction
exists.

- Local daemon holding the store in memory, answering "notes for this place" in
  under 30 ms; a thin shim per client that calls it.
- Client integrations, in this order:
  1. **OpenCode** (the developer's own client): plugin on `tool.execute.after`,
     session explanation through `instructions`.
  2. **Claude Code:** `PreToolUse` hook (before the call), `SessionStart` hook.
  3. **Codex:** `PostToolUse` and `SessionStart` hooks; places from shell
     command text.
  4. **Cursor:** `postToolUse` and `sessionStart` hooks.
- The explanation line at session start (the one tested as `PUSH_INSTRUCTION`),
  plus project-level items there.
- Ranking v1: anchor specificity first (symbol > file > folder > project), then
  type, then recency; at most 3 per touch; never repeat a shown note in a session
  unless it is a warning and the agent is editing.
- Prompt-cache rules. Agent sessions depend on the provider's prompt cache (the
  stored attention state of an unchanged prompt prefix); anything that changes
  earlier context makes every later call slower and more expensive. So:
  - the session-start explanation is fixed text, identical in every session;
    project-level items go after it, and only at session start;
  - notes are only ever appended after a tool result, never inserted earlier;
  - a changed or superseded note is delivered as a new note, never by editing
    text the agent already saw;
  - every delivered note stays in the context for the rest of the session, so
    the 280-character limit and the per-touch cap also bound its running cost.
- CLI: `bifrost note add|list|edit|retire`, with anchors given as paths or folders.
- Telemetry, local only: which notes were shown, when, to which session.

**Done when** the developer uses it daily with OpenCode on a real repository,
the experiment tasks replayed through the real daemon reproduce the explained-push
results, and p95 latency is under 30 ms.

### M2. From work history to candidates (3 weeks)

- Adapters → typed work events (read, search, edit, create, run, test, prompt,
  reply, commit, revert), scrubbed locally (secrets, tokens, paths outside the
  repository).
- Placement: Graphify adapter for symbols; path and folder fallback without a map.
- Episodes: one attempt at one thing, split on prompts, commits and long gaps.
- **Steering detection first.** The developer's own messages that correct or
  constrain the agent ("no, …", "we always …", "don't …", "use … instead") are
  the richest source the experiments found. Rules flag them; the episode around
  each one is the candidate.
- Other tier-1 rules: repeated failures at one place, fixes after failures,
  reverts, verified work (tests pass after edits), unfinished work.
- Outcome linking: tests, reverts and later corrections attach to the episode
  they judge.

**Done when**, on the developer's real sessions (OpenCode first, through
`tools/export-steering.mjs` for the backlog), most of their corrections become
candidates, and a sample of candidates is judged worth keeping by the developer
at a measured rate.

### M3. Extraction and reconciliation in the service (3 weeks)

- Service endpoint: scrubbed episode digests in, typed items out, no retention.
- Extraction prompt and checks carry the experiment lessons:
  - an approach from a failed episode is never written as a `how-to` or a fix;
    only outcome-confirmed approaches are;
  - a note about a file created in the episode is anchored to its folder;
  - every item cites its evidence (episode, outcome, user message).
- Reconciliation against items already at the same places: add, reinforce,
  refine, supersede or dismiss; rules first, the model only for ambiguous cases.
- Admission threshold, and a review queue: low-confidence items wait for the
  developer's yes or no in the CLI before agents see them.
- Default model: a cheap hosted open-weight model; measure cost per session.

**Done when**, replaying the experiment tasks from their failed sessions,
generated items reach the pass rate of hand-written ones, and on real sessions
the developer keeps a high share of the items that reach agents.

### M4. Lifecycle and correction (2 weeks)

- Staleness: when anchored code changes substantially, items are flagged for
  revalidation and drop in ranking.
- Supersession and decay, as in architecture §9.
- Corrections from agents and the developer (`confirm`, `dispute`, `correct`)
  enter reconciliation as high-trust events.
- Noise control: items that are shown often but never acted on lose rank;
  relevance to the current action (the file being written, the command being
  run) weighs more than type.

**Done when** a noise replay (correct items among irrelevant ones) no longer
hides correct items, and stale items stop being shown after their code changes.

### M5. Presence and objectives (parallel track after M1, 2–3 weeks)

- Liveness from lifecycle hooks, trace tailing and a process watcher
  (study §6.1).
- Declared objectives from prompts, plans, titles and branches; inference only
  where they are missing.
- Shown at session start ("two other sessions are working in `src/auth/`").

**Done when** the liveness state matches real sessions, including killed
terminals, and objectives read correctly to the developer.

### M6. Service boundary and pilot (2 weeks)

- Hosted endpoint hardened: authentication, metering, the no-retention contract
  enforced and documented.
- Install path: one command sets up the daemon and the hooks for the clients
  found on the machine.
- Pilot with a handful of developers who run several agents; measure what M1–M4
  measured, on their repositories.

## 5. Order and timing

```text
week  1      2  3      4  5  6      7  8  9      10 11     12 13
      M0 ─── M1 ────── M2 ───────── M3 ───────── M4 ────── M6 ────
                       M5 (parallel) ──────
```

About three months to a pilot, with a usable tool for the developer from week 3.

## 6. How progress is measured

- **Regression evals:** the experiment tasks (taste, undocumented, vendor, noise)
  become a test suite run against the real daemon and pipeline; every change to
  ranking, extraction or delivery reruns them.
- **Precision:** the share of shown items the developer keeps, from the review
  queue and from corrections.
- **Recall of steering:** the share of the developer's corrections that later
  reach an agent as an item.
- **Repeat corrections:** how often the developer has to say the same thing
  twice. This is the number version 1 exists to bring down.
- **Latency and cost:** p95 per tool call; model cost per session.

## 7. Risks and how the plan handles them

| Risk | Handling |
|---|---|
| Extraction writes plausible but wrong advice. | Outcome-confirmed rule, evidence on every item, review queue below the admission threshold, regression evals with failed sessions. |
| Noise hides the notes that matter. | Strict admission, relevance-aware ranking, demotion of ignored items, noise replay in the evals. |
| The trusted channel becomes an injection route. | Only items from the Bifröst store are delivered; text is sanitised and length-capped; items from sources outside the developer's own sessions need review; the explanation line says what the notes are without granting them authority over the user's request. |
| Clients that deliver after the call show notes late. | Session-start context and folder anchors carry conventions before the first write; measured per client in the evals. |
| Delivery breaks the agent's prompt cache and raises its cost. | Fixed session-start text, append-only notes, supersession as new notes (M1); measure cached-token share per session with and without Bifröst. |
| Client hook APIs change. | One thin shim per client, kept small; the daemon does the work. |
| Free-tier models are rate-limited during development. | Evals run on small models and low effort; strong models only for final checks. |

## 8. Decided, deferred, open

- **Decided:** what gets admitted, push with an explanation, folder anchors,
  outcome-confirmed extraction, cheap hosted extraction model, local store.
- **Deferred:** team sharing and sync, cloud agents, overlap alerts, embeddings.
- **Open, to settle during the build:** the admission threshold (M3); how
  aggressively to demote ignored notes (M4); whether project-level items need
  their own budget at session start (M1); Cursor CLI hook support (M1).
