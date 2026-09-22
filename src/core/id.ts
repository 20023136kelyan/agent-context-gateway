/**
 * Stable ID helpers. Format: {harness}:{sessionId}:{turnKey}
 * turnKey = native uuid where available, else ordinal.
 */
import type { Harness } from "./models.js";

export function agentId(harness: Harness, key: string): string {
  return `${harness}:${key}`;
}

export function turnId(harness: Harness, sessionId: string, turnKey: string): string {
  const safe = turnKey.replace(/[^a-zA-Z0-9-_]/g, "").slice(0, 64) || "0";
  return `${harness}:${sessionId}:${safe}`;
}

/**
 * Vector rows are per embedding window, not per turn (see `chunkForEmbedding`).
 * Window 0 keeps the bare turn id, so rows written before chunking existed are
 * already valid window-0 rows: dedup still recognises them, no corpus needs
 * re-embedding, and a long turn embedded earlier simply gains its missing tail.
 * `#` is safe as the separator because `turnId` strips it from every turnKey.
 */
export function embedChunkId(turn: string, index: number): string {
  return index === 0 ? turn : `${turn}#${index}`;
}

/** Inverse of `embedChunkId`: the turn a stored vector belongs to. */
export function chunkTurnId(id: string): string {
  const hash = id.lastIndexOf("#");
  if (hash === -1) return id;
  // Only a numeric suffix is ours; a `#` inside an exotic sessionId stays put.
  return /^\d+$/.test(id.slice(hash + 1)) ? id.slice(0, hash) : id;
}

const VALID_HARNESSES = new Set(["claude-code", "codex", "cursor", "zep", "git", "trajectory", "opencode"]);

export function parseTurnId(id: string): { harness: Harness; sessionId: string; turnKey: string } | null {
  const parts = id.split(":");
  if (parts.length < 3) return null;
  const [harness, sessionId, ...rest] = parts;
  if (!VALID_HARNESSES.has(harness)) return null;
  return { harness: harness as Harness, sessionId, turnKey: rest.join(":") };
}
