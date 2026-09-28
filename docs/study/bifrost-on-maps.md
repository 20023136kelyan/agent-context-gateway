# Bifröst on a system map: design from the study

This document turns the Graphify and Graphiti studies into design decisions, one section per question:

1. how to add a layer to a map;
2. how agents discover and use maps;
3. how maps update;
4. the map as a spatial anchor;
5. serving the layer to agents.

Every claim about the tools points to the detailed studies ([Graphify](./graphify.md), [Graphiti](./graphiti.md)).

---

## 1. Adding a layer to a map

**Graphify is the map.** Graphiti is a memory engine and plays no part in the anchoring.

**Rules for the coupling:**

1. **Read, never write.** Bifröst reads `graphify-out/graph.json`. It never adds fields or nodes to it: the file is rebuilt, guarded against shrinking, sorted, and merged by Graphify's own git driver.
2. **Keep a separate store.** Bifröst keeps its records (findings, tasks, presence, activity) in its own local store, keyed by Bifröst anchors (§4).
3. **Join when displaying.** Map nodes and Bifröst records are joined only when something is rendered. Graphify's own overlay works the same way: a sidecar keyed by node ID, merged in at render time.
4. **Hide the map behind an adapter.** A small interface, so Graphify is the first map rather than the only one:

```ts
interface MapAdapter {
  id: "graphify" | string;
  // Freshness
  version(): { builtAtCommit?: string; mtimeMs: number };   // reload when changed
  isFreshFor(path: string): boolean;                         // file mtime <= map mtime
  // Place resolution
  symbolsIn(path: string): MapSymbol[];                      // ordered by start line
  nodeFor(path: string, symbol?: string): MapSymbol | null;
  // Neighbourhood
  neighbors(nodeId: string, opts: { relations?: string[]; hops?: 1 | 2 }): MapEdge[];
  dependents(nodeId: string, depth?: number): MapSymbol[];   // like `graphify affected`
  area(nodeId: string): { label: string; members: string[] } | null;
}
interface MapSymbol { nodeId: string; label: string; path: string; startLine: number; endLine: number; kind: string }
interface MapEdge { from: string; to: string; relation: string; confidence: "EXTRACTED" | "INFERRED" | "AMBIGUOUS"; line?: number }
```

The Graphify adapter loads `graph.json` once and indexes it by path and by node ID. It re-reads the file when `(mtime, size)` changes, as `graphify.serve` does (a reload took 56 ms here). `endLine` is derived: the next symbol's start line minus one, within the same file.

---

## 2. How agents discover and use maps, and what Bifröst takes from it

| Mechanism | Graphify | Graphiti | Bifröst |
|---|---|---|---|
| Skill | Yes, 20+ platforms | No | Yes: a short skill explaining notes, `at`, `note`, `vote` |
| Always-on instructions (`CLAUDE.md`, `AGENTS.md`, Cursor rules) | Yes | No | Yes: needed on Codex and Cursor |
| `PreToolUse` hook | Yes: a generic nudge, 65 ms | No | **Yes: the primary channel, with place-specific content** |
| MCP tools | Yes | Yes | Yes |
| Application injects results into the prompt | No | Zep's model | Not applicable |

The lesson from Graphify: **instructions and tool descriptions alone don't make an agent use a map.** That is why Graphify added hooks, and then a strict mode that blocks the first read. Its hooks still only *remind*. Bifröst's advantage is that its hook can carry the content itself, so the agent never has to decide to ask.

---

## 3. How maps update, and how Bifröst keeps up

**What Graphify does:**

- rebuilds in the background on commit and branch switch (3–4 s here);
- needs a manual `update` after a pull;
- can watch files, with a 3 s debounce;
- misses uncommitted work unless `watch` runs;
- rebuilds communities on every change, and they move a lot (263 nodes renumbered by one added function).

**What Bifröst does:**

1. **Watch the map file.** When `graph.json` changes, rebuild the anchor-binding cache (§4.3). No separate git hook is needed for the map.
2. **Watch git for renames.** On `HEAD` change, run `git diff -M --name-status <old> <new>` and carry path anchors across renames *before* the map rebuild lands. This catches the case where Graphify replaced all 13 node IDs in a renamed file.
3. **Never block on the map.** When the map is stale for a file (the file's mtime is later than `graph.json`), resolve by path and line against the working file. Mark map-derived context as possibly behind.
4. **Detect staleness from the code, not the map.** Hash each anchored symbol's text on disk when the note is written, and again at delivery time (§4.4). This works even when the map is behind.

---

## 4. The map as a spatial anchor

### 4.1 Anchor record

```ts
interface Anchor {
  repo: string;                 // remote URL or repo ID
  path: string;                 // repo-relative, as of `commit`
  symbol?: string;              // "SearchService.search"; language-agnostic dotted path
  lineStart?: number; lineEnd?: number;
  commit: string;               // HEAD when anchored
  spanHash?: string;            // hash of the normalized symbol text (or line range)
  // Derived cache: rebuilt from the map and never trusted without re-checking
  binding?: { map: "graphify"; nodeId: string; builtAtCommit?: string };
}
```

Levels of precision, finest first:

1. symbol (preferred);
2. line range, when there is no symbol, such as config files;
3. file;
4. directory.

The repository itself is the coarsest level: a note on the repo appears only at session start.

### 4.2 Resolution: from an agent's action to places

Input: a tool event such as `Read src/search/search.ts` (optionally with a line range), an `Edit` with an old string, or a `Grep` hit list.

1. **Path:** normalize to repo-relative. Ignore anything outside the repo.
2. **Symbols touched:**
   - *Edit:* the symbols whose span contains the changed lines.
   - *Read with an offset:* the symbols overlapping the range.
   - *Whole-file read:* the file itself.
   - Spans come from `MapAdapter.symbolsIn(path)` when the map is fresh for the file. Otherwise from a cheap local tree-sitter or regex pass over the current file.
3. **Candidate notes:**
   - **direct:** anchors on the same symbol, on the file, or with an overlapping line range;
   - **near:** anchors one hop away through `calls`, `imports`, `inherits` or `implements`, where the edge is `EXTRACTED` or `INFERRED` with score ≥ 0.8;
   - **dependents:** for an `Edit`, the callers of the edited symbol (like `graphify affected`, depth 1). This is where "someone else relies on this behaviour" warnings come from.
4. Pass the candidates to the surfacing rules (§5.4).

### 4.3 Binding and re-binding when the map changes

- When the map changes, recompute `binding.nodeId` for each anchor from `path` and `symbol`.
- If `path` no longer exists, follow the git rename map from §3.2.
- If `symbol` is gone from the file, try, in order:
  1. the same label elsewhere in the file (moved);
  2. the same label with the same caller and callee labels anywhere in the repo (moved file, missed by git);
  3. otherwise mark the anchor **orphaned**. It is then shown only through `where(topic)` and in session-start orientation, labelled "place no longer exists".
- **Never bind to communities.** For "area" labels, use a smoothed area: the most frequent community *label* for the symbol over the last N builds, shown for orientation only.

### 4.4 Staleness

| Check | When | Result |
|---|---|---|
| `spanHash` unchanged | Delivery | Show normally |
| `spanHash` changed | Delivery | Show with "code changed since this note (<age>)". Lower rank for `how-to` and `decision`; keep full rank for `warning` and `known-issue`. |
| Anchor orphaned | Map rebuild | Remove from place-based delivery |
| Newer note of the same type on the same anchor | Write | Mark superseded (explicit, §4.5) |

Graphify flags entries stale per file. Here, appending one comment line flagged every entry in the file. A per-span hash avoids that.

### 4.5 Time and supersession (taken from Graphiti, made explicit)

- Every record carries:
  - `validFrom`: when the observation was true;
  - `recordedAt`: when it was written;
  - `validUntil`, `supersededBy`, `supersededAt`.
- Supersession happens only through an explicit act:
  - an agent's `supersede(noteId, newNote)`;
  - a `vote(-1)` threshold;
  - a rule, such as a `reverted` task state superseding the `in-progress` note on the same anchor.
- An LLM may *suggest* a supersession during offline extraction. It becomes real only after confirmation.
- Delivery defaults to "true now". This is the opposite of Graphiti's search default, which returned the superseded warning in the test.

---

## 5. Serving the layer to agents

### 5.1 Process layout

```text
agent tool call ──► hook shim (tiny binary or node script, <5 ms start)
                        │  unix socket / localhost
                        ▼
                 bifrost daemon (long-running)
                   ├─ store (sqlite)
                   ├─ MapAdapter(graphify) ── watches graphify-out/graph.json
                   ├─ git watcher (HEAD, renames)
                   └─ per-session state (what was shown, presence)
```

Graphify's guard starts a Python process on every tool call (65 ms here). **Bifröst's budget is 30 ms end to end at p95**: a small shim talking to a warm daemon. If the daemon doesn't answer within about 50 ms, the shim prints nothing. It fails open, like Graphify's guard.

### 5.2 Channels, by platform

| Platform | Place-triggered delivery | Session start | Pull (MCP) | Writes |
|---|---|---|---|---|
| Claude Code | `PreToolUse` on `Read\|Edit\|Write\|MultiEdit\|Grep` → `additionalContext` | `SessionStart` hook | Yes | `PostToolUse` (activity, presence); `Stop`/`SessionEnd` (note prompt) |
| Gemini CLI | `BeforeTool` → `additionalContext`, always allow | Instructions | Yes | Instructions |
| Codex | **Not possible:** Codex Desktop rejects `additionalContext` on `PreToolUse` | `AGENTS.md` block | Yes | `AGENTS.md` asks for `bifrost.note` at the end |
| Cursor | Not possible | `.cursor/rules/bifrost.mdc` (`alwaysApply`) | Yes | Rules |
| Others | By the hook capability of each | Instruction file | Yes | Instruction file |

On Codex and Cursor the instruction line is: "Before editing a file, call `bifrost.at` with its path." Measure this weaker channel separately in the experiment.

### 5.3 What the agent sees

Match Graphify's line style so the two read as one map in the transcript:

```text
BIFRÖST src/auth/refresh.ts › refreshSession
  WARNING   3d · codex · ✓2      Retrying inside refreshSession() loops on 401s; the fix was reverted in a1b2c3d.
  TASK      failing · claude-code · live 4m   Token rotation under concurrent refresh
  near › callers: SessionGuard.renew
  DECISION  9d · claude-code      Refresh must fail fast; SessionGuard owns retries.   [code changed since]
```

Limits:

- at most 3 records, and at most 150 tokens including the header;
- one line per record: type, age, author system, votes, then the text of up to 280 characters.

Every line from the store passes through a label sanitizer (strip control characters, cap length), because Bifröst text goes straight into model context. Graphify does the same with `sanitize_label`.

### 5.4 Surfacing rules: when to speak, when to stay silent

1. **Nothing relevant means print nothing.** No header, no "no notes".
2. **Show each record once per session**, unless it changed or its code changed since it was shown. Per-session state is kept by `session_id`, which Claude Code sends in the hook input.
3. **Ranking:**
   1. direct before near before dependents;
   2. `warning` and `known-issue`, then `in-progress` from live presence, then `decision`, `open-thread`, `how-to`;
   3. votes;
   4. recency.
4. **Budget:** cut to 3 records or 150 tokens, whichever comes first. Graphify's renderer does the same, with seeds first and cutting by hop distance.
5. **Reads repeat, edits matter more.** Read triggers stay silent once the place has been shown this session. Edit triggers re-show `warning` and `known-issue` records on the edited symbol even if already shown.
6. **Never block.** No `permissionDecision`, ever. Tell users not to combine Bifröst with Graphify's `--strict` mode, because a denied read also hides Bifröst's note for that read.

### 5.5 Pull tools (MCP)

| Tool | Returns |
|---|---|
| `bifrost.at(path, symbol?, lines?)` | Same content as the hook, larger budget (≤ 400 tokens) |
| `bifrost.where(topic)` | Places (path › symbol) with their top records. Lexical plus embedding match over notes, then grouped by anchor. **Not** transcripts. |
| `bifrost.note(anchor, type, text)` | Writes a finding (≤ 280 characters). The anchor defaults to the last edited symbol. |
| `bifrost.vote(id, +1\|-1)`, `bifrost.supersede(id, text)` | Corrections |
| `bifrost.task(anchor, state, text)` | Task state changes |

Optionally, a **Graphify proxy**: an MCP server that forwards Graphify's tools and appends Bifröst lines to `get_node`, `get_neighbors` and `query_graph` results for the returned nodes, inside the same token budget. Graphify reloads per call and returns plain text, so appending is simple. The longer-term option is to propose an overlay-provider hook upstream. Graphify's own learning overlay shows the insertion point: `_subgraph_to_text`, where `learning=` is added.

### 5.6 Presence

- `PostToolUse` events update `{session, agentSystem, place, since}` records. Graphify has none of this; its `prs` command only maps worktrees and branches to PRs.
- A presence record expires 10 minutes after the session's last event.
- A place counts as "live" when another session touched the same symbol or file in that window.
- Presence shows only for other sessions, and only on direct places.

---

## 6. What to build first, for the upper-bound experiment

1. **Graphify adapter**: load, index, derive spans, watch mtime. Test it on this repository's graph: 1,144 nodes, and the ID and rename cases from the study.
2. **Anchor resolver and span hashing**, with the git rename carry-over. Replay the rename test from the study (13 nodes in `rank.ts` → `ranking.ts`) and check that every anchor follows.
3. **Daemon, store and Claude Code `PreToolUse` shim.** Measure p95 latency against the 30 ms budget.
4. **Hand-authored findings** on the trap tasks, delivered through 3, with Graphify installed in both arms, so the only difference is Bifröst.
5. **Codex arm** through `AGENTS.md` and MCP, to measure the pull-only channel.

Deferred until the experiment passes:

- offline extraction;
- `where(topic)` embeddings;
- the Graphify MCP proxy;
- a Graphiti export;
- community smoothing.
