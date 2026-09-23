/**
 * Canonical data model — Agent Context Gateway MVP.
 * Source of truth remains native history; these types are normalized views.
 * See IMPLEMENTATION_PLAN_V2.md §3 and spec §8.
 */

export type Harness = "claude-code" | "codex" | "cursor" | "zep" | "git" | "trajectory" | "opencode";

export type TurnRole = "user" | "assistant" | "tool" | "system" | "unknown";

export interface Agent {
  id: string;
  harness: Harness;
  name?: string;
  /** MVP: always null (no topology yet, spec §17 deferred) */
  parentAgentId: null;
  machineId: string;
  metadata: Record<string, unknown>;
}

export interface Session {
  id: string;
  harness: Harness;
  agentId: string;
  /** Project slug: Claude dir slug, or Codex cwd basename */
  projectId: string;
  /** Absolute cwd where the session ran */
  workspace: string;
  /** Git repo root resolved from workspace (null outside repos). */
  repo?: string | null;
  gitBranch?: string;
  startedAt: string;
  endedAt?: string;
  /** Native file this session was parsed from */
  sourcePath: string;
}

export interface Turn {
  id: string;
  sessionId: string;
  harness: Harness;
  timestamp: string;
  role: TurnRole;
  /** Normalized searchable text (capped at 8k chars for MVP) */
  content: string;
  /** Opaque native payload reference — never mutated */
  raw: unknown;
  toolNames?: string[];
  fileRefs?: string[];
  /**
   * false = context only: shown in result windows and read by the action
   * index, but never indexed or embedded for retrieval. Tool CALLS (a shell
   * command, an edit's path) are short and keyword-dense; ranked alongside
   * discussion they crowded the pool and cost 0.03-0.06 NDCG@5 on real history.
   */
  searchable?: boolean;
  /** Order within session (0-based) */
  seq: number;
  /** Byte offset in source JSONL for direct retrieval */
  byteOffset?: number;
}

export interface Artifact {
  kind: "file" | "patch" | "commit" | "pr" | "url" | "other";
  ref: string;
  sessionId: string;
  turnId: string;
}

export interface Provenance {
  harness: Harness;
  agentId: string;
  sessionId: string;
  turnId: string;
  timestamp: string;
  sourcePath: string;
  byteOffset?: number;
}

export interface SearchResult {
  score: number;
  /** MVP: extractive (first lines), never LLM-generated */
  summary?: string;
  provenance: Provenance;
  /** Center hit + ±expansion window */
  context: Turn[];
  artifacts?: string[];
}

export interface SearchQuery {
  q: string;
  project?: string;
  harness?: Harness;
  sessionId?: string;
  maxResults?: number;
  maxTurns?: number;
  maxTokens?: number;
}
