/**
 * Live Context Search & Context Subscriptions (spec §66-67).
 * - Live Search: Queries actively running sessions in real-time (bypassing the index)
 * - Subscriptions: Agents register interest in queries; notified when matching context appears.
 */
import { stat } from "node:fs/promises";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import type { ContextAdapter } from "../adapters/types.js";
import type { Session, Turn } from "../core/models.js";

export interface LiveSearchResult {
  session: Session;
  activeTurns: Turn[];
  matchedTurns: Turn[];
  isLive: true;
  lastActiveAt: string;
}

export interface Subscription {
  id: string;
  query: string;
  harness?: string;
  webhookUrl?: string;
  createdAt: string;
  lastNotifiedAt?: string;
}

export interface SubscriptionNotification {
  subscriptionId: string;
  query: string;
  matchingTurns: Turn[];
  deliveredAt: string;
}

export class SubscriptionStore {
  private subs = new Map<string, Subscription>();
  constructor(private path: string) {
    this.load();
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf8")) as { subscriptions?: Subscription[] };
      if (Array.isArray(raw.subscriptions)) {
        for (const s of raw.subscriptions) this.subs.set(s.id, s);
      }
    } catch {
      // ignore
    }
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify({ version: 1, subscriptions: [...this.subs.values()] }, null, 2));
  }

  subscribe(query: string, opts?: { harness?: string; webhookUrl?: string }): Subscription {
    const id = `sub_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const sub: Subscription = {
      id,
      query: query.trim(),
      harness: opts?.harness,
      webhookUrl: opts?.webhookUrl,
      createdAt: new Date().toISOString(),
    };
    this.subs.set(id, sub);
    this.save();
    return sub;
  }

  unsubscribe(id: string): boolean {
    const deleted = this.subs.delete(id);
    if (deleted) this.save();
    return deleted;
  }

  all(): Subscription[] {
    return [...this.subs.values()];
  }

  /**
   * Evaluates newly indexed turns against active subscriptions.
   * Returns notifications for matches.
   */
  notifyTurns(newTurns: Turn[]): SubscriptionNotification[] {
    const notifications: SubscriptionNotification[] = [];
    const now = new Date().toISOString();

    for (const sub of this.subs.values()) {
      const terms = sub.query.toLowerCase().split(/\s+/).filter(Boolean);
      const matches = newTurns.filter((t) => {
        if (sub.harness && t.harness !== sub.harness) return false;
        const hay = t.content.toLowerCase();
        return terms.every((term) => hay.includes(term));
      });

      if (matches.length > 0) {
        sub.lastNotifiedAt = now;
        notifications.push({
          subscriptionId: sub.id,
          query: sub.query,
          matchingTurns: matches,
          deliveredAt: now,
        });
      }
    }

    if (notifications.length > 0) this.save();
    return notifications;
  }
}

/**
 * Searches currently active sessions (modified within the active window) directly
 * from native history, bypassing the index for zero-latency live context.
 */
export async function searchLiveSessions(
  adapters: ContextAdapter[],
  query: string,
  opts?: { activeWindowMs?: number; maxTurnsPerSession?: number },
): Promise<LiveSearchResult[]> {
  const windowMs = opts?.activeWindowMs ?? 15 * 60 * 1000; // 15 minutes default
  const now = Date.now();
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const results: LiveSearchResult[] = [];

  for (const adapter of adapters) {
    const sessions = await adapter.listSessions().catch(() => []);
    for (const s of sessions) {
      try {
        const st = await stat(s.sourcePath);
        // Is session file active? (modified within activeWindowMs)
        if (now - st.mtimeMs <= windowMs) {
          const turns = await adapter.listTurns(s.id).catch(() => []);
          const recentTurns = turns.slice(-(opts?.maxTurnsPerSession ?? 20));
          const matched = recentTurns.filter((t) => {
            const hay = t.content.toLowerCase();
            return terms.some((term) => hay.includes(term));
          });

          if (matched.length > 0) {
            results.push({
              session: s,
              activeTurns: recentTurns,
              matchedTurns: matched,
              isLive: true,
              lastActiveAt: new Date(st.mtimeMs).toISOString(),
            });
          }
        }
      } catch {
        continue;
      }
    }
  }

  results.sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));
  return results;
}

export function defaultSubscriptionsPath(stateDir?: string): string {
  const base = stateDir ?? process.env.CONTEXT_GATEWAY_STATE ?? `${process.env.HOME ?? "/tmp"}/.context-gateway`;
  return join(base, "subscriptions.json");
}
