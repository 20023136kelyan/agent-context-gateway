# Map study: Graphify and Graphiti

This study asks how Bifröst should sit on top of a system map. It covers how the leading tools are built, how agents find and use them, how they update, how a map can anchor Bifröst's records, and how to serve those records to agents.

Method: read both codebases end to end, run Graphify on this repository, and run Graphiti on its embedded driver with a scripted LLM. Every number comes from those runs.

| Document | What it covers |
|---|---|
| [graphify.md](./graphify.md) | Pipeline, graph format, ID scheme, extraction quality, communities, agent discovery (skill, instructions, hooks, MCP), query engine, updates, the work-memory overlay, measurements |
| [graphiti.md](./graphiti.md) | Data model, episode ingestion, the temporal model and supersession, search and rerankers, drivers, MCP and REST, measurements, defects |
| [bifrost-on-maps.md](./bifrost-on-maps.md) | The design that follows: how Bifröst is built and updated from work history (events → placement → classification → add, update or dismiss), the map adapter and anchors, keeping up with map and code changes, serving, the local/service boundary, first build steps |
| [probes/](./probes/) | The scripts used for the measurements |

## Findings

1. **Only Graphify is a code map.** Graphiti is a temporal memory graph built by an LLM from text. It has no parser and no notion of files or symbols. For Bifröst it is a model for the note store's time semantics, not an anchor.
2. **Graphify's IDs are path-derived.** A file rename replaced all 13 node IDs in the file, with no link from old to new. Nodes have start lines only. Bifröst must store its own anchors and treat Graphify IDs as a cache it re-resolves.
3. **Graphify's communities are unstable.** Adding one 1-line function renumbered 263 nodes' communities. 436 of 1,383 nodes ended up in a community sharing less than half its members with their previous one. Communities can't be anchors.
4. **Graphify already has a small work-memory overlay.** A sidecar keyed by node ID is merged into MCP `query_graph` output as `learning=preferred:stale`. Its staleness is per file: one appended comment flagged every entry in the file. It carries a status word, not content, and appears in no other tool. It proves the overlay pattern, and signals Graphify's direction.
5. **Graphify's hooks show the channel works, but they carry no content.** A `PreToolUse` guard on every Read and Grep costs 65 ms here and injects the same "MANDATORY: run graphify first" text every time. Bifröst uses the same channel for place-specific notes, through a warm daemon, within 30 ms.
6. **Graphify works on Codex and Cursor through instruction files, its skill, CLI and MCP.** Only its per-tool-call context injection is Claude Code and Gemini only. Its code notes that Codex Desktop rejects injected context on `PreToolUse`, and it gives Cursor only a rules file. Whether Codex CLI or Cursor hooks can inject context is untested. Until it is, Bifröst plans for the same fallback there (instruction files, MCP pull, session start), and the experiment should measure that path.
7. **Graphiti's temporal model is worth copying.** Keep separate validity and system times, and supersede instead of deleting. Two parts should not be copied:
   - its default search returns superseded facts;
   - it asks an LLM about every new fact; Bifröst settles most cases with rules and runs its models in the service.
8. **Graphiti needs a database server.** Its only embedded driver (Kuzu) is deprecated, and broken on current main in two ways found here. Every episode costs 3–4 LLM calls or more. Telemetry is on by default.

## Reproducing

```bash
# Graphify
python3 -m venv gvenv && gvenv/bin/pip install graphifyy "mcp>=1"
git archive work-layer | tar -x -C bf && (cd bf && git init -q && git add -A && git commit -qm base)
gvenv/bin/graphify extract bf --code-only        # 1,144 nodes / 3,223 edges on this branch
cp bf/graphify-out/graph.json g0.json            # then edit, `graphify update`, and diff:
gvenv/bin/python probes/graph_diff.py g0.json g1.json
gvenv/bin/python probes/mcp_probe.py             # MCP tools, latency, hot reload

# Graphiti (embedded Kuzu, no API keys; the probe patches the two Kuzu defects)
python3 -m venv tivenv && tivenv/bin/pip install "graphiti-core[kuzu]" httpx
GRAPHITI_TELEMETRY_ENABLED=false tivenv/bin/python probes/graphiti_triplet_probe.py
GRAPHITI_TELEMETRY_ENABLED=false tivenv/bin/python probes/graphiti_episode_probe.py
```

Versions studied: Graphify 0.9.70 (`4c21b15`) and Graphiti 0.30.2 (`6b4b56f`), both dated 27 Sep 2026.
