/**
 * Bi-temporal Memory & Derived Invalidation Markers (Zep/Graphiti & spec §43, §69).
 * Tracks two timelines:
 * - Event Time (T): when the fact was stated in native turn history
 * - Transaction Time (T'): when the gateway derived/indexed the invalidation
 *
 * Implements non-destructive invalidation:
 * - Current search filters out or marks superseded turns
 * - Point-in-time queries (asOf: ISO) faithfully reconstruct historical knowledge
 * - Derived state: reconstructible from native histories via detectSupersessions
 */
import { readFileSync, appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import type { Turn } from "../core/models.js";
import { STOP } from "../search/query.js";

export interface InvalidationRecord {
  id: string;
  supersededTurnId: string;
  supersedingTurnId: string;
  reason: string;
  supersededAt: string; // Event time of superseding turn
  derivedAt: string; // Transaction time
  sourceSessionId: string;
}

// An optional determiner is skipped so "replaced the editor" targets "editor", not "the".
const DETERMINER = "(?:(?:the|a|an|our|my|this|that|these|those|its|their|your)\\s+)?";
const SUPERSEDE_CUES = [
  "(?:replaces?|replacing|replaced)",
  "(?:deprecated?|deprecating)",
  "(?:no\\s+longer\\s+using|abandoning|abandoned|dropped|dropping)",
  "(?:swapped\\s+out|migrated\\s+away\\s+from|switching\\s+away\\s+from)",
  "(?:supersedes?|superseded)",
].map((verb) => new RegExp(`\\b${verb}\\s+${DETERMINER}([A-Za-z0-9_.-]+)\\b`, "i"));

const ADOPTION_CUE = /\b(agreed|decided|use|using|adopt|adopted)\b/i;

/** Captures that can't name the thing being replaced. */
const NON_TARGETS = new Set([...STOP, "it", "this", "that", "with", "all", "some", "any", "one", "old", "new"]);

export class TemporalStore {
  private records = new Map<string, InvalidationRecord>(); // key: supersededTurnId
  constructor(private path: string) {
    this.load();
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    try {
      const lines = readFileSync(this.path, "utf8").split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        const rec = JSON.parse(line) as InvalidationRecord;
        if (rec.supersededTurnId) this.records.set(rec.supersededTurnId, rec);
      }
    } catch {
      // corrupt file -> empty map
    }
  }

  recordInvalidation(rec: Omit<InvalidationRecord, "id" | "derivedAt">): InvalidationRecord {
    const full: InvalidationRecord = {
      id: `inv:${rec.supersededTurnId}->${rec.supersedingTurnId}`,
      derivedAt: new Date().toISOString(),
      ...rec,
    };
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, JSON.stringify(full) + "\n");
    this.records.set(full.supersededTurnId, full);
    return full;
  }

  /**
   * Checks if a turn is superseded as of a given point in time.
   * If asOfIso is provided, invalidations that occurred after that event time are ignored.
   */
  getInvalidation(turnId: string, asOfIso?: string): InvalidationRecord | null {
    const rec = this.records.get(turnId);
    if (!rec) return null;
    if (asOfIso && rec.supersededAt > asOfIso) {
      // The invalidation happened after the query's asOf timestamp; turn was still valid then!
      return null;
    }
    return rec;
  }

  isSuperseded(turnId: string, asOfIso?: string): boolean {
    return this.getInvalidation(turnId, asOfIso) !== null;
  }

  all(): InvalidationRecord[] {
    return [...this.records.values()];
  }

  clear(): void {
    this.records.clear();
    if (existsSync(this.path)) writeFileSync(this.path, "");
  }

  /**
   * Automatically detects and records supersessions by scanning historical turns.
   * (e.g. Turn B "We decided to replace Monaco" supersedes Turn A "We agreed on Monaco").
   */
  deriveFromTurns(turns: Turn[]): InvalidationRecord[] {
    const newlyDerived: InvalidationRecord[] = [];
    const sorted = [...turns].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    // Once per turn, not once per (turn, earlier turn) pair.
    const lowered = sorted.map((t) => t.content.toLowerCase());
    const adopts = sorted.map((t) => ADOPTION_CUE.test(t.content));

    for (let i = 0; i < sorted.length; i++) {
      const curr = sorted[i];
      for (const pat of SUPERSEDE_CUES) {
        const m = curr.content.match(pat);
        if (!m) continue;
        const targetEntity = m[1].toLowerCase().replace(/[.-]+$/, "");
        if (targetEntity.length < 3 || NON_TARGETS.has(targetEntity)) continue;
        // Whole-word mention: "kafka" must not match inside "kafkaesque".
        const mention = new RegExp(`\\b${targetEntity.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);

        // Look for earlier turns that adopted or agreed to that entity
        for (let j = 0; j < i; j++) {
          const prev = sorted[j];
          if (adopts[j] && mention.test(lowered[j])) {
            if (!this.records.has(prev.id)) {
              const rec = this.recordInvalidation({
                supersededTurnId: prev.id,
                supersedingTurnId: curr.id,
                reason: `Superseded by turn stating: "${curr.content.slice(0, 120)}"`,
                supersededAt: curr.timestamp,
                sourceSessionId: curr.sessionId,
              });
              newlyDerived.push(rec);
            }
          }
        }
      }
    }
    return newlyDerived;
  }
}

export function defaultTemporalPath(stateDir?: string): string {
  const base = stateDir ?? process.env.CONTEXT_GATEWAY_STATE ?? `${process.env.HOME ?? "/tmp"}/.context-gateway`;
  return join(base, "invalidations.jsonl");
}
