/**
 * P3 feedback store — explicit helpful/not-helpful marks per turn.
 * JSONL sidecar (one line per mark, latest wins). Human/agent feedback is
 * the only learning signal in the ranker; absence changes nothing.
 */
import { readFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

export interface FeedbackMark {
  turnId: string;
  helpful: boolean;
  ts: string;
  note?: string;
}

export class FeedbackStore {
  private marks = new Map<string, FeedbackMark>();
  constructor(private path: string) {
    this.load();
  }

  private load(): void {
    try {
      if (!existsSync(this.path)) return;
      for (const line of readFileSync(this.path, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const m = JSON.parse(line) as FeedbackMark;
          if (m.turnId) this.marks.set(m.turnId, m);
        } catch {
          // skip corrupt lines, keep the rest
        }
      }
    } catch {
      // unreadable -> empty
    }
  }

  record(turnId: string, helpful: boolean, note?: string): FeedbackMark {
    const mark: FeedbackMark = { turnId, helpful, ts: new Date().toISOString(), note };
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, JSON.stringify(mark) + "\n");
    this.marks.set(turnId, mark);
    return mark;
  }

  /** +0.15 helpful, -0.30 not (floored at total 0 by caller). 0 = no signal. */
  delta(turnId: string): number {
    const m = this.marks.get(turnId);
    if (!m) return 0;
    return m.helpful ? 0.15 : -0.3;
  }

  size(): number {
    return this.marks.size;
  }
}

export function defaultFeedbackPath(stateDir?: string): string {
  const base = stateDir ?? process.env.CONTEXT_GATEWAY_STATE ?? `${process.env.HOME ?? "/tmp"}/.context-gateway`;
  return join(base, "feedback.jsonl");
}
