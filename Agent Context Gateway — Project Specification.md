# Agent Context Gateway

**Status:** Concept / Architecture Specification  
**Type:** Open-source infrastructure  
**Primary purpose:** Federated, on-demand access to agent context and work history across agent harnesses  
**Core principle:** Native agent histories remain the source of truth.

---

# 1. Executive Summary

The **Agent Context Gateway** is an open-source infrastructure layer that allows one AI agent to retrieve relevant context from another agent's existing work history.

The gateway is designed for environments where multiple agents, agent harnesses, sessions, machines, or development environments are operating on the same or related work.

An agent should be able to ask questions such as:

> "What did Codex decide about PR #169?"

> "Did the Claude Code session already investigate this bug?"

> "What did my parent agent conclude about the database architecture?"

> "Find the previous session where we discussed replacing Monaco."

> "What files did the other agent modify when implementing collaboration?"

The gateway searches the relevant agent's **native session/history data**, retrieves the relevant turns or context, and returns them with provenance.

The gateway is therefore best understood as:

> **Federated semantic search over native agent work histories.**

It is **not** primarily a new memory database.

---

# 2. Problem

Modern agentic development increasingly involves multiple agents.

A single project may simultaneously contain:

- a Codex session
- a Claude Code session
- a Cursor session
- several Cozea agents
- background subagents
- agents operating on different machines
- agents operating in different worktrees
- human developers collaborating with agents

Each environment often maintains its own history.

This creates a fundamental problem:

```text
                 Agent A
                    │
              native history
                    │
                    X
                    │
              Agent B cannot
              easily query it
                    │
              native history
                    │
                 Agent B
```

The information exists, but it is trapped inside the context boundary of the originating agent or harness.

Agents consequently repeat work.

For example:

1. Agent A investigates a bug.
2. Agent A determines the root cause.
3. Agent A finishes its session.
4. Agent B encounters the same issue.
5. Agent B has no practical way to know that Agent A already solved it.
6. Agent B investigates everything again.

The problem becomes even more significant with subagents.

A parent agent may have made an important architectural decision several turns or sessions earlier, while a child agent only needs a small piece of that reasoning.

Passing the entire parent context is inefficient.

The desired primitive is therefore:

```text
Agent B
   │
   │ "What did Agent A conclude about X?"
   ▼
Context Gateway
   │
   ├── identify Agent A
   ├── search Agent A's native history
   ├── retrieve relevant turns
   ├── preserve provenance
   └── return compact context
   │
   ▼
Agent B
```

---

# 3. Goals

## 3.1 Primary goals

The system MUST:

1. Allow one agent to query another agent's context.
2. Support semantic/natural-language search.
3. Search existing native agent histories where possible.
4. Preserve the original source and provenance of retrieved information.
5. Avoid requiring agents to manually save memories.
6. Work across different agent harnesses.
7. Support parent/child agent relationships.
8. Support agents running on different machines.
9. Return only the context necessary to answer the query.
10. Be usable as an infrastructure primitive independently of Cozea.
11. Be open source.
12. Permit multiple transport mechanisms, with MCP being an important initial interface.
13. Make indexes/caches disposable and rebuildable.
14. Avoid turning the gateway into the authoritative owner of agent history.

---

# 4. Non-Goals

The gateway is NOT intended to be:

### 4.1 A replacement for native agent history

The originating harness remains authoritative.

```text
Native history
      ↓
SOURCE OF TRUTH
      ↓
Context Gateway
```

not:

```text
Agent
  ↓
Gateway
  ↓
new permanent memory database
```

---

### 4.2 A traditional memory database

The project should not require users to maintain a separate database containing every agent interaction.

A derived index may exist for search performance, but:

> **The index is disposable.**

If it disappears, it should be possible to reconstruct it from native histories.

---

### 4.3 A universal agent memory system

Systems such as long-term memory stores, knowledge graphs, and memory databases solve a related but different problem.

The gateway's central abstraction is:

> **"Find something another agent already did or knew."**

not:

> **"Create a new persistent memory of this interaction."**

---

### 4.4 A replacement for agent-to-agent communication

A2A-style systems can be used for:

- assigning work
- exchanging tasks
- exchanging artifacts
- live agent communication

The Context Gateway instead answers:

> "What has already happened?"

These systems can therefore coexist.

---

### 4.5 A hidden synchronization mechanism

The gateway should not silently modify another agent's context.

It is primarily a retrieval layer.

---

# 5. Core Concept

The central abstraction is a **Context Source**.

A Context Source is an agent/harness history that can be queried.

For example:

```text
Context Source
├── Harness: Codex
├── Agent: agent-42
├── Session: session-981
├── Project: Cozea
├── Machine: workstation-A
└── History
    ├── turn 1
    ├── turn 2
    ├── turn 3
    └── ...
```

Another source might be:

```text
Context Source
├── Harness: Claude Code
├── Agent: claude-agent-7
├── Session: session-112
├── Project: Cozea
└── History
```

The gateway provides a common interface over these heterogeneous sources.

---

# 6. Federated Architecture

The architecture should be adapter-based.

```text
                         Agent
                           │
                           ▼
                  Context Gateway API
                           │
             ┌─────────────┼─────────────┐
             │             │             │
             ▼             ▼             ▼
        Codex Adapter  Claude Adapter  Cursor Adapter
             │             │             │
             ▼             ▼             ▼
       Native History Native History Native History
```

Additional adapters can later support:

- Cozea
- custom agent runtimes
- OpenAI Agents SDK
- local agent frameworks
- enterprise agent systems
- other open-source coding agents

The gateway itself should know as little as possible about any individual harness.

---

# 7. Harness Adapter

Each harness adapter translates a native history format into the gateway's normalized representation.

An adapter should conceptually expose capabilities such as:

```text
listSessions()
getSession()
listTurns()
getTurn()
search()
getAgent()
getParent()
getChildren()
getProject()
getWorkspace()
```

Not every adapter must support every capability.

Capabilities should therefore be discoverable.

Example:

```json
{
  "harness": "codex",
  "capabilities": [
    "sessions",
    "turns",
    "search",
    "parent_child_topology"
  ]
}
```

---

# 8. Normalized Context Model

The gateway should define a small canonical data model.

## 8.1 Agent

```text
Agent
├── id
├── harness
├── name
├── parentAgentId?
├── machineId?
└── metadata
```

---

## 8.2 Session

```text
Session
├── id
├── agentId
├── projectId?
├── workspace?
├── startedAt
├── endedAt?
└── metadata
```

---

## 8.3 Turn

A turn represents a unit of conversation or agent activity.

```text
Turn
├── id
├── sessionId
├── timestamp
├── role
├── content
├── toolCalls?
├── toolResults?
├── artifacts?
├── files?
└── metadata
```

The canonical model should not require every harness to expose all fields.

---

## 8.4 Artifact

An artifact may include:

- file
- patch
- commit
- PR
- command output
- generated document
- URL
- structured result

Artifacts should retain references to their originating session/turn whenever possible.

---

# 9. Provenance

Provenance is a fundamental requirement.

A retrieved statement should never appear to be anonymous gateway knowledge.

For example:

```text
Result:

"The collaboration layer currently shares files rather than
sharing a session workbench."

Source:
  Harness: Codex
  Session: abc123
  Turn: turn_47
  Timestamp: 2026-09-13T08:42:12Z
```

This allows an agent to distinguish:

```text
FACT FROM SOURCE
```

from:

```text
GATEWAY INTERPRETATION
```

and:

```text
MODEL-GENERATED SUMMARY
```

These should remain conceptually distinct.

---

# 10. Search

Search is the primary operation.

The user/agent should be able to issue natural-language queries.

Example:

```text
"What did the other agent decide about replacing Monaco?"
```

The gateway should translate this into a search over relevant histories.

Possible search pipeline:

```text
Natural-language query
        │
        ▼
Query normalization
        │
        ▼
Source selection
        │
        ▼
Candidate retrieval
        │
        ├── lexical search
        ├── semantic search
        ├── metadata filtering
        └── structural filtering
        │
        ▼
Ranking
        │
        ▼
Context expansion
        │
        ▼
Provenance attachment
        │
        ▼
Compact result
```

---

# 11. Search Should Be Federated

The gateway should not require all data to be centralized.

Possible architecture:

```text
                   Gateway
                      │
          ┌───────────┼───────────┐
          ▼           ▼           ▼
      Machine A   Machine B   Machine C
          │           │           │
       Codex        Claude       Cozea
       history      history      history
```

Each machine may maintain its own local searchable representation.

The gateway can federate queries across them.

This makes the architecture suitable for:

- laptops
- workstations
- remote development machines
- CI agents
- cloud environments
- private enterprise infrastructure

---

# 12. Local-First Architecture

A strong default architecture is:

```text
Native History
      │
      ▼
Local Adapter
      │
      ▼
Local Index
      │
      ▼
Gateway
      │
      ▼
Remote Agent
```

The native history does not necessarily need to leave the machine.

Only matching context needs to be returned.

This has several advantages:

- lower bandwidth
- better privacy
- simpler permissions
- lower infrastructure cost
- easier offline operation
- native ownership of data

---

# 13. Indexing

Indexes are implementation details.

An index may contain:

```text
turn ID
session ID
timestamp
text embedding
lexical tokens
metadata
file references
project references
```

But:

> The index is NOT authoritative.

It must be possible to delete and reconstruct it.

For example:

```text
Native histories
      │
      ▼
Indexer
      │
      ▼
Search index
```

If:

```text
Search index
      X
```

then:

```text
Native histories
      │
      ▼
rebuild
      │
      ▼
Search index
```

---

# 14. Search Backends

The architecture should not hard-code one search technology.

Potential implementations include:

### Lexical

- SQLite FTS
- Tantivy
- PostgreSQL full-text search

### Vector

- local vector index
- pgvector
- embedded vector databases

### Hybrid

The preferred long-term strategy is likely hybrid retrieval:

```text
semantic similarity
        +
lexical relevance
        +
metadata filtering
        +
conversation structure
```

However, the first implementation should favor simplicity.

---

# 15. Context Expansion

A search hit alone is frequently insufficient.

Suppose turn 48 contains:

> "Yes, we should replace Monaco."

The preceding turns may explain why.

The gateway should therefore support context windows.

Example:

```text
Search hit:
    turn 48

Expanded:
    turn 44
    turn 45
    turn 46
    turn 47
    turn 48
    turn 49
    turn 50
```

The agent can then receive enough context to understand the decision.

Context expansion should be bounded.

---

# 16. Relevance Ranking

Ranking should consider more than semantic similarity.

Potential ranking signals:

```text
semantic similarity
lexical similarity
timestamp
project match
workspace match
file match
agent relationship
session relevance
tool/artifact relevance
explicit entity matches
```

For example, if an agent asks:

> "What did my parent decide about PR #169?"

then the gateway should strongly prioritize:

```text
parent agent
+
PR #169
+
decision-like language
```

rather than unrelated semantically similar conversations.

---

# 17. Agent Topology

One of the gateway's important capabilities is understanding relationships between agents.

Example:

```text
Parent Agent
│
├── Child Agent A
│
├── Child Agent B
│
└── Child Agent C
```

This enables queries such as:

> "What did my parent decide?"

> "What did my sibling agent discover?"

> "Did any child agent already investigate this?"

> "What did the research subagent conclude?"

Topology should therefore be represented explicitly when the underlying harness exposes it.

---

# 18. Parent/Child Context

A particularly important use case is subagents.

Consider:

```text
Parent
  │
  ├── Subagent A
  ├── Subagent B
  └── Subagent C
```

Subagent B should not necessarily receive the entire parent history.

Instead:

```text
Subagent B
     │
     │ query
     ▼
Context Gateway
     │
     ▼
Parent history
     │
     ▼
relevant context only
```

This provides a form of **selective context inheritance**.

The principle is:

> Context should be retrievable, not necessarily inherited wholesale.

---

# 19. Cross-Harness Queries

The gateway should normalize across harnesses.

Example:

```text
Claude Code
     │
     │ "What did Codex conclude?"
     ▼
Context Gateway
     │
     ▼
Codex Adapter
     │
     ▼
Codex native history
```

The Claude agent does not need to understand Codex's internal history format.

Likewise:

```text
Codex
  │
  ▼
Gateway
  │
  ▼
Claude Code history
```

---

# 20. MCP Interface

MCP is a natural initial transport/interface for the gateway.

The gateway itself should remain conceptually independent of MCP.

Architecture:

```text
                  Agent
                    │
                    ▼
                  MCP
                    │
                    ▼
          Context Gateway
                    │
        ┌───────────┼───────────┐
        ▼           ▼           ▼
      Codex       Claude      Cursor
```

MCP provides a convenient mechanism for exposing gateway operations to agents.

Potential MCP tools:

```text
context.list_sources
context.list_sessions
context.search
context.get_session
context.get_turn
context.get_context
context.get_topology
```

The exact API should be designed around agent ergonomics rather than exposing every internal operation.

---

# 21. Suggested Core Tool

The most important interface should probably be extremely simple.

Conceptually:

```text
context.search(
    query="What did the other agent decide about collaboration?",
    scope="relevant"
)
```

Possible response:

```json
{
  "results": [
    {
      "relevance": 0.94,
      "summary": "...",
      "source": {
        "harness": "codex",
        "agentId": "...",
        "sessionId": "...",
        "turnId": "..."
      },
      "context": [...]
    }
  ]
}
```

The interface should optimize for agents asking useful questions rather than forcing them to understand the underlying storage model.

---

# 22. Scope

Search scope should be controllable.

Possible scopes:

```text
current_session
current_agent
parent
children
siblings
project
workspace
machine
organization
all_available
```

Example:

```text
scope="parent"
```

or:

```text
scope="project"
```

The gateway should also support automatic scope selection.

For example:

```text
scope="auto"
```

could determine that:

> "What did my parent decide about X?"

requires searching the parent.

---

# 23. Access Control

Because context may contain sensitive information, authorization is fundamental.

The gateway must never assume:

```text
agent exists
→ agent can read everything
```

Instead:

```text
request
  │
  ▼
identity
  │
  ▼
authorization
  │
  ▼
scope evaluation
  │
  ▼
search
```

Potential permissions:

```text
read own history
read parent history
read child history
read project history
read organization history
read machine-local history
```

Permissions should be explicit.

---

# 24. Privacy

The gateway should follow a data-minimization principle.

If an agent asks:

> "What did the other agent decide about PR #169?"

the gateway should not return the other agent's entire history.

It should return:

- relevant turns
- necessary surrounding context
- provenance
- relevant artifacts

and nothing more.

---

# 25. Security Boundary

The gateway is effectively a **context access broker**.

Therefore:

```text
Agent
  │
  │ authenticated request
  ▼
Gateway
  │
  │ authorization
  ▼
Context source
```

The adapter must enforce that the caller cannot arbitrarily read local history files merely because the gateway has access to them.

The implementation should separate:

1. identity
2. authorization
3. source discovery
4. retrieval
5. result filtering

---

# 26. Source Discovery

Agents should be able to discover what context sources exist.

Example:

```text
Available Context Sources

1. Codex
   Project: Cozea
   Agent: main
   Sessions: 12

2. Claude Code
   Project: Cozea
   Agent: research
   Sessions: 4

3. Cozea
   Organization: ...
   Agents: 8
```

Discovery should respect permissions.

---

# 27. Project Awareness

Project/workspace identity is an important search signal.

For example:

```text
Agent A
  project = Cozea

Agent B
  project = unrelated-project
```

If Agent B asks:

> "What did the other agent decide about collaboration?"

the gateway should not necessarily search every conversation ever created.

The default scope should usually prioritize the current project/workspace.

Possible identity:

```text
Project
├── projectId
├── repository
├── workspace
├── machine
└── branch
```

---

# 28. Repository Awareness

Git repositories provide particularly useful context.

Search can use:

- repository
- branch
- commit
- PR
- issue
- file path

Example:

```text
"What did the previous agent discover while working on src/collaboration?"
```

The gateway can heavily prioritize sessions that touched:

```text
src/collaboration
```

---

# 29. Temporal Queries

The system should support time-aware queries.

Examples:

> "What did we decide yesterday?"

> "Find the session where this was investigated last week."

> "What changed after the previous architecture decision?"

Possible filters:

```text
before
after
between
latest
earliest
relative time
```

---

# 30. Decision Retrieval

A particularly valuable higher-level operation is finding decisions.

Agents frequently need:

```text
Why did we choose X?
```

rather than:

```text
Find messages containing X.
```

The gateway should therefore eventually support decision-oriented retrieval.

Conceptually:

```text
query
  ↓
find discussion
  ↓
find conclusion
  ↓
find rationale
  ↓
return decision + provenance
```

However, decision extraction should remain derived from the underlying history rather than becoming a separate authoritative memory store.

---

# 31. "Why" Queries

Examples:

> "Why did we decide not to use Monaco?"

> "Why was this architecture rejected?"

> "Why did the previous agent choose Convex?"

These queries should retrieve:

1. decision
2. rationale
3. alternatives considered
4. relevant evidence
5. source turns

---

# 32. Artifact Retrieval

Agent history often contains more than natural-language discussion.

Search should eventually be able to connect context to artifacts.

Example:

```text
"What did the agent change for the collaboration implementation?"
```

Result:

```text
Decision
   ↓
Session
   ↓
Turns
   ↓
Files
   ↓
Commit
   ↓
PR
```

This makes the gateway much more useful for software engineering workflows.

---

# 33. Context Graph

The system may eventually represent relationships such as:

```text
Agent
  │
  ├── created → Session
  │
  ├── parent-of → Agent
  │
  └── worked-on → Project

Session
  │
  ├── contains → Turn
  ├── modified → File
  ├── created → Commit
  └── references → PR
```

This should be considered an optional derived model.

The graph must not become the required source of truth.

---

# 34. Derived Knowledge

The gateway may produce:

- summaries
- embeddings
- extracted entities
- detected decisions
- topic labels
- file relationships
- project relationships

All such information should be explicitly treated as:

```text
DERIVED
```

rather than:

```text
AUTHORITATIVE
```

If derived data becomes stale, it should be regenerated.

---

# 35. Failure Model

A source may be unavailable.

Example:

```text
Agent A
  │
  ▼
remote machine offline
```

The gateway should report:

```text
Source unavailable
```

rather than fabricate results.

Likewise, if a search index is stale:

```text
Index may be stale.
Last synchronized: ...
```

The gateway should make freshness visible when relevant.

---

# 36. No Hallucinated Context

This is a critical design requirement.

The gateway should never claim:

> "The previous agent decided X"

unless the retrieved history supports it.

Generated summaries must be clearly distinguishable from source evidence.

Preferred:

```text
Summary:
The agent appears to have concluded X.

Evidence:
Session abc123, turns 41–47.
```

rather than:

```text
The previous agent decided X.
```

without provenance.

---

# 37. Native History Adapters

The project should initially prioritize a small number of adapters.

Potential initial targets:

1. Codex
2. Claude Code
3. Cursor
4. Cozea

Additional adapters can be contributed later.

Each adapter should be independently maintained.

---

# 38. Adapter Contract

Conceptually:

```typescript
interface ContextAdapter {
  identify(): Promise<AdapterIdentity>

  listAgents(): Promise<Agent[]>

  listSessions(agentId?: string): Promise<Session[]>

  getSession(sessionId: string): Promise<Session>

  listTurns(sessionId: string): Promise<Turn[]>

  getTurn(
    sessionId: string,
    turnId: string
  ): Promise<Turn>

  search(
    query: SearchQuery
  ): Promise<SearchResult[]>
}
```

The real interface should remain minimal and capability-driven.

---

# 39. Remote Sources

The gateway should support remote context sources.

Example:

```text
Machine A
┌───────────────────────┐
│ Agent Gateway Node    │
│                       │
│ Codex Adapter         │
│ Claude Adapter        │
│ Local Index           │
└───────────┬───────────┘
            │
            │ secure connection
            ▼
Machine B
┌───────────────────────┐
│ Agent Gateway Node    │
│                       │
│ Cozea Adapter         │
│ Local Index           │
└───────────────────────┘
```

A centralized gateway can then federate queries.

---

# 40. Deployment Models

The project should support multiple deployment modes.

## Mode A — Local

```text
Agent
 ↓
Local Gateway
 ↓
Local histories
```

Best for personal development.

---

## Mode B — Machine Gateway

```text
Multiple local agents
        ↓
Machine Gateway
        ↓
Machine histories
```

Best for shared development machines.

---

## Mode C — Federated

```text
                Gateway
             /     |      \
            /      |       \
       Machine A Machine B Machine C
```

Best for teams.

---

## Mode D — Embedded

The gateway can be embedded directly into an agent runtime.

```text
Agent Runtime
 ├── Context Gateway
 └── Native History
```

---

# 41. Storage Philosophy

The system should default toward:

```text
history owned by harness
index owned by gateway
```

rather than:

```text
history copied into gateway database
```

The gateway should minimize duplication.

---

# 42. Synchronization

Synchronization should be incremental where possible.

Example:

```text
Native history
    │
    ├── turn 1
    ├── turn 2
    ├── turn 3
    └── turn 4 ← new
                 │
                 ▼
              index
```

Adapters should ideally expose a cursor or modification timestamp.

---

# 43. Eventual Consistency

Remote indexes may be eventually consistent.

This is acceptable.

The system should communicate freshness when it matters.

Example:

```text
Source last indexed:
2026-09-15 00:43 UTC
```

A direct source lookup can optionally bypass the index when high freshness is required.

---

# 44. Direct Retrieval vs Search

Two fundamentally different operations should exist.

### Search

```text
"What did they say about collaboration?"
```

### Direct retrieval

```text
"Get session abc123 turn 48."
```

Search finds relevant information.

Direct retrieval provides authoritative source data.

---

# 45. Context Packaging

Results should be optimized for agent consumption.

Avoid returning enormous transcripts.

A good result might look like:

```text
Relevant context

[1] Codex / Session abc123 / Turns 41–48
Topic: Collaboration architecture

Summary:
The session concluded that session workbenches remain
private to each user while files are the shared primitive.

Evidence:
Turn 47:
...

Turn 48:
...

Related artifacts:
- src/collaboration/...
- PR #169
```

This is much more useful than dumping 500 turns.

---

# 46. Token Efficiency

The gateway exists partly because context is expensive.

Therefore, results should support:

```text
summary
+
small evidence window
+
optional full retrieval
```

The agent can request more context only when necessary.

Example:

```text
search()
    ↓
compact answer
    ↓
get_context()
    ↓
larger evidence
```

---

# 47. Context Budget

Search responses should support an explicit context budget.

Conceptually:

```text
maxTokens
maxTurns
maxResults
maxSessions
```

This allows agents to control retrieval cost.

---

# 48. Agent-Friendly API

The API should optimize for questions rather than database operations.

Bad:

```text
SELECT ...
FROM ...
WHERE ...
```

Good:

```text
search("What did the parent decide about X?")
```

The gateway should hide unnecessary implementation complexity.

---

# 49. Human Interface

A human-facing UI is optional but valuable.

Possible interface:

```text
Context Gateway
────────────────────────────

Search
[ What did Codex decide about collaboration? ]

Sources
☑ Codex
☑ Claude Code
☑ Cursor
☑ Cozea

Scope
Project: Cozea

Results
────────────────────────────
Codex · Session #abc123
Relevant turns: 42–48

...
```

The UI is secondary.

The primary consumer is another agent.

---

# 50. Observability

The gateway should expose operational information such as:

- source availability
- index status
- last synchronization
- search latency
- adapter failures
- authorization failures
- result counts

It should avoid logging sensitive retrieved content unnecessarily.

---

# 51. Performance Targets

The system is intended for interactive agent use.

The target should be:

```text
simple local search: tens of milliseconds
semantic local search: low hundreds of milliseconds
remote federated search: sub-second when possible
```

Exact targets should be established through benchmarks.

The critical principle is:

> Context retrieval should be dramatically cheaper than restarting an investigation.

---

# 52. Comparison With Full Context Handoff

Traditional agent handoff may do:

```text
Parent
  │
  ▼
entire conversation history
  │
  ▼
Child
```

The gateway provides:

```text
Parent history
      │
      ▼
semantic retrieval
      │
      ▼
small relevant context
      │
      ▼
Child
```

Advantages:

- fewer tokens
- less latency
- less noise
- better isolation
- better scalability
- cross-harness compatibility

---

# 53. Comparison With Memory Databases

A memory database typically looks like:

```text
Agent
  ↓
memory extraction
  ↓
memory database
  ↓
future retrieval
```

The gateway instead looks like:

```text
Agent
  ↓
native history
  ↓
gateway index
  ↓
future retrieval
```

The difference is important.

The gateway does not require an agent to remember to write a memory.

If something happened in the native history, it is potentially searchable.

---

# 54. Relationship With Zep

Systems such as Zep provide sophisticated shared memory and graph-based retrieval.

That is a useful adjacent category.

The Context Gateway should not attempt to compete by simply becoming another memory database.

The differentiation is:

> **Native-history federation.**

Zep-like systems may still be useful alongside the gateway.

For example:

```text
                    Agent
                      │
            ┌─────────┴─────────┐
            ▼                   ▼
     Context Gateway          Memory
            │                   │
     native histories       persistent memories
```

These solve different problems.

---

# 55. Relationship With A2A

A2A-style protocols are appropriate for:

- agent discovery
- tasks
- delegation
- task status
- artifacts
- agent-to-agent workflows

The Context Gateway is concerned with:

- historical context
- previous decisions
- previous investigations
- prior work
- session retrieval

A future system may use both:

```text
A2A
 ↓
"Please investigate X."

Context Gateway
 ↓
"What has already been investigated about X?"
```

---

# 56. Relationship With MCP

MCP is primarily an interface/transport mechanism.

The gateway is the actual capability.

Therefore:

```text
Context Gateway
      │
      ├── MCP
      ├── HTTP
      ├── SDK
      └── CLI
```

MCP should not become a hard architectural dependency.

---

# 57. CLI

A CLI would be useful for debugging and humans.

Example:

```bash
context-gateway sources
```

```bash
context-gateway sessions
```

```bash
context-gateway search "what did the previous agent decide about collaboration?"
```

```bash
context-gateway session abc123
```

```bash
context-gateway turn abc123 turn47
```

---

# 58. SDK

The project should eventually provide an SDK.

Potential usage:

```typescript
const context = await gateway.search({
  query: "What did the previous agent decide about collaboration?",
  scope: "project"
})
```

The SDK should return structured provenance-rich results.

---

# 59. Language Support

The gateway should ideally support:

- TypeScript
- Python
- Rust

However, the first implementation should choose one language and keep the protocol language-neutral.

---

# 60. Open Source Architecture

The repository should be modular.

Suggested structure:

```text
agent-context-gateway/
│
├── core/
│   ├── models/
│   ├── search/
│   ├── ranking/
│   ├── authorization/
│   └── federation/
│
├── adapters/
│   ├── codex/
│   ├── claude-code/
│   ├── cursor/
│   └── cozea/
│
├── transports/
│   ├── mcp/
│   ├── http/
│   └── cli/
│
├── indexing/
│   ├── lexical/
│   ├── vector/
│   └── hybrid/
│
├── sdk/
│
├── docs/
│
└── tests/
```

The exact structure can change during implementation.

---

# 61. MVP

The first version should remain deliberately small.

## MVP requirements

### Source

Support one native harness initially.

### Operations

Implement:

```text
list sessions
read session
search history
retrieve surrounding context
```

### Search

Start with:

```text
lexical search
```

before introducing sophisticated embeddings.

### Interface

Provide:

```text
CLI
+
simple HTTP API
```

MCP can then be layered on top.

### Provenance

Every result MUST identify:

```text
harness
agent
session
turn
timestamp
```

where available.

---

# 62. MVP Example

Suppose Codex has:

```text
Session A

Turn 1:
Investigate collaboration architecture.

Turn 2:
Session workbench should remain private.

Turn 3:
Files are the shared primitive.

Turn 4:
Autogit should ask before rebasing from main.
```

Claude asks:

```text
"What was decided about collaboration?"
```

Gateway returns:

```text
Codex — Session A

Decision:
The session workbench is private to each participant.
Files are the shared primitive.

Source:
Session A
Turns 2–3
```

Claude can then ask:

```text
"Why?"
```

and the gateway can retrieve the surrounding discussion.

---

# 63. Phase 2

Add:

- semantic search
- hybrid ranking
- multiple adapters
- parent/child topology
- project-aware search
- remote gateways
- authorization
- context budgets
- artifact relationships

---

# 64. Phase 3

Add:

- federated multi-machine search
- decision extraction
- temporal reasoning
- richer artifact graph
- advanced ranking
- automatic source discovery
- live synchronization
- human UI

---

# 65. Phase 4

Potential advanced features:

- cross-agent research
- automatic context suggestions
- context subscriptions
- change notifications
- "what changed since last session?"
- agent lineage exploration
- historical project intelligence
- organization-wide agent knowledge discovery

These should remain secondary to the core retrieval primitive.

---

# 66. Context Subscriptions

A future extension could allow:

```text
Agent B
  │
  │ subscribe
  ▼
Agent A context
```

and receive notifications when relevant new context appears.

Example:

```text
"Notify me if another agent makes a decision about
the collaboration architecture."
```

This turns the gateway from purely pull-based retrieval into:

```text
pull + optional push
```

---

# 67. Live Context

The gateway may eventually search active sessions.

Example:

```text
Agent A is currently working.

Agent B:
"What is Agent A currently investigating?"
```

If permissions allow, the gateway can retrieve recent active context.

This is particularly useful in collaborative environments.

---

# 68. Context Freshness

Results should optionally expose:

```text
source timestamp
index timestamp
retrieval timestamp
```

This allows an agent to determine whether information may have changed.

---

# 69. Conflict Handling

Different agents may have conflicting conclusions.

Example:

```text
Agent A:
Use architecture X.

Agent B:
Architecture X was rejected.
```

The gateway should not silently merge them.

Instead, return:

```text
Conflicting findings

Agent A — Session A:
...

Agent B — Session B:
...
```

The consuming agent can then reason about the conflict.

---

# 70. No Artificial Consensus

The gateway should retrieve evidence.

It should not automatically decide which agent is correct.

A future optional reasoning layer could analyze disagreement, but that should remain separate.

---

# 71. Reproducibility

Because native histories remain authoritative, a result should be reproducible.

A user should be able to follow:

```text
Search result
    ↓
Session
    ↓
Turn
    ↓
Original history
```

and verify the claim.

---

# 72. Extensibility

The project should be designed around adapters.

Adding a new harness should ideally require implementing:

```text
ContextAdapter
```

rather than modifying the gateway core.

For example:

```text
New Harness
    ↓
Adapter
    ↓
Canonical Context Model
    ↓
Existing Search / Auth / Federation
```

---

# 73. Core Design Principles

The project should follow these principles.

### Principle 1 — Native history is truth

Never make the gateway's index more authoritative than the original history.

### Principle 2 — Retrieval, not forced memory

Agents should not need to explicitly save information.

### Principle 3 — Provenance always

Retrieved information should be traceable.

### Principle 4 — Least context necessary

Return relevant context rather than entire histories.

### Principle 5 — Local-first

Keep sensitive histories local whenever possible.

### Principle 6 — Adapter-driven

Never couple the core to one harness.

### Principle 7 — Protocol-independent

MCP is useful, but the gateway should not be fundamentally dependent on it.

### Principle 8 — Agent-first

The primary interface is optimized for agents.

### Principle 9 — Human-verifiable

Humans should be able to inspect the original evidence.

### Principle 10 — Disposable derived state

Indexes, embeddings, summaries, and graphs should be rebuildable.

---

# 74. Conceptual Architecture

The complete conceptual system is:

```text
                         AGENTS
                           │
             ┌─────────────┼─────────────┐
             │             │             │
           Codex        Claude Code    Cozea
             │             │             │
             ▼             ▼             ▼
        Native History Native History Native History
             │             │             │
             ▼             ▼             ▼
        Harness Adapter Harness Adapter Harness Adapter
             │             │             │
             └─────────────┼─────────────┘
                           ▼
                 CONTEXT GATEWAY
                           │
        ┌──────────────────┼──────────────────┐
        │                  │                  │
        ▼                  ▼                  ▼
     Search             Topology         Authorization
        │                  │                  │
        └──────────────────┼──────────────────┘
                           ▼
                    Context Results
                           │
                  ┌────────┴────────┐
                  ▼                 ▼
              Summary           Evidence
                                    │
                                    ▼
                              Provenance
```

---

# 75. Relationship to the Broader Agent Infrastructure Stack

The Context Gateway is one primitive in a broader agent-computer ecosystem.

Conceptually:

```text
                         AGENTS
                            │
          ┌─────────────────┼──────────────────┐
          │                 │                  │
          ▼                 ▼                  ▼
       AID              Agentic UI       Context Gateway
          │                 │                  │
          ▼                 ▼                  ▼
     Computer/device    Applications       Agent history
      interaction       interaction         retrieval
          │                 │                  │
          └─────────────────┼──────────────────┘
                            │
                            ▼
                   Collaborative Sessions
                            │
                            ▼
                         COZEA
```

The abstractions are complementary:

### AID

```text
Agent → computer/device
```

### Agentic UI

```text
Agent → application
```

### Context Gateway

```text
Agent → previous agent work
```

### Collaborative Sessions

```text
Agent ↔ agent ↔ human ↔ machine
```

### Cozea

```text
Compose these primitives into a workspace.
```

---

# 76. The Fundamental Abstraction

The project can ultimately be summarized by one idea:

> **An agent should be able to query the work that other agents have already done without requiring those agents to manually create memories or transfer their entire context.**

The gateway turns isolated histories:

```text
Agent A ── History A

Agent B ── History B

Agent C ── History C
```

into a federated context space:

```text
                 Context Gateway
                /       |       \
               /        |        \
        History A   History B   History C
               \        |        /
                \       |       /
                 Federated Search
                       │
                       ▼
                    Any Agent
```

while preserving the most important architectural constraint:

```text
                 SOURCE OF TRUTH
                       │
                       ▼
              Native Agent History
                       │
                       ▼
              Context Gateway Index
                       │
                       ▼
                 Agent Retrieval
```

The gateway therefore does not attempt to become the place where agent knowledge lives.

It becomes the **way agents find knowledge that already exists elsewhere**.

---

# 77. Initial Implementation Checklist

## Repository

- [ ] Create repository
- [ ] Define license
- [ ] Define canonical data model
- [ ] Define adapter interface
- [ ] Define search interface
- [ ] Define provenance format

## Core

- [ ] Context source abstraction
- [ ] Agent abstraction
- [ ] Session abstraction
- [ ] Turn abstraction
- [ ] Search result abstraction
- [ ] Provenance abstraction

## First adapter

- [ ] Identify native history location
- [ ] Parse sessions
- [ ] Parse turns
- [ ] Normalize messages
- [ ] Preserve source IDs
- [ ] Preserve timestamps
- [ ] Implement search

## Search

- [ ] Basic lexical index
- [ ] Query API
- [ ] Ranking
- [ ] Context expansion
- [ ] Metadata filtering

## Interface

- [ ] CLI
- [ ] HTTP API
- [ ] MCP server

## Security

- [ ] Source authorization
- [ ] Agent identity
- [ ] Permission model
- [ ] Sensitive-data handling

## Testing

- [ ] Adapter tests
- [ ] Search tests
- [ ] Provenance tests
- [ ] Permission tests
- [ ] Cross-session tests
- [ ] Parent/child tests

---

# 78. Acceptance Criteria

The MVP should not be considered complete until the following scenario works:

### Scenario

There are two independent agent sessions.

```text
Session A
  Agent: Codex
  Project: Cozea

Session B
  Agent: Claude Code
  Project: Cozea
```

Session A discusses and resolves an architectural question.

Session B subsequently asks:

```text
"What did Codex decide about the collaboration architecture?"
```

The gateway must:

1. identify relevant Codex history,
2. search it,
3. locate the relevant discussion,
4. retrieve enough surrounding context,
5. produce a concise result,
6. identify the originating session,
7. identify the originating turns,
8. allow those turns to be retrieved directly,
9. avoid returning unrelated history,
10. avoid requiring Session A to explicitly save a memory.

If that works reliably, the fundamental concept has been proven.

---

# 79. Long-Term Vision

The long-term vision is a world in which agent context is no longer artificially isolated by the boundaries of individual harnesses.

Instead of:

```text
Claude knows what Claude did.
Codex knows what Codex did.
Cursor knows what Cursor did.
Cozea knows what Cozea did.
```

we can have:

```text
                 Federated Agent Context
                           │
        ┌──────────────────┼──────────────────┐
        │                  │                  │
      Claude             Codex              Cozea
        │                  │                  │
        └──────────────────┼──────────────────┘
                           │
                      Cursor etc.
```

while still allowing each system to retain ownership of its own history.

This creates an important distinction:

> **Federated context does not require centralized memory.**

The histories can remain distributed, private, and native to their respective systems.

The gateway simply provides a standardized way to ask:

> **"What happened over there?"**

and receive the relevant answer with enough evidence to trust it.

---

# 80. One-Sentence Definition

**Agent Context Gateway is an open-source, federated context retrieval layer that lets agents semantically search and retrieve relevant context from other agents' native histories—across sessions, subagents, harnesses, and machines—without requiring a separate authoritative memory database.**