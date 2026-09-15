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

const VALID_HARNESSES = new Set(["claude-code", "codex", "cursor", "zep", "git"]);

export function parseTurnId(id: string): { harness: Harness; sessionId: string; turnKey: string } | null {
  const parts = id.split(":");
  if (parts.length < 3) return null;
  const [harness, sessionId, ...rest] = parts;
  if (!VALID_HARNESSES.has(harness)) return null;
  return { harness: harness as Harness, sessionId, turnKey: rest.join(":") };
}
