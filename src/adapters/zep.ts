/**
 * Zep Context Lake Adapter (spec §54).
 * Federates Zep memory threads and temporal facts as a Context Source.
 * Source of truth remains Zep; normalized into Session and Turn objects.
 * Supports local Zep JSON exports or live REST API if configured via
 * ZEP_API_URL and ZEP_API_KEY environment variables.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Harness, Session, Turn } from "../core/models.js";
import { turnId as makeTurnId } from "../core/id.js";
import type { ContextAdapter, FileCursor } from "./types.js";
import { truncate, extractFileRefs } from "./text.js";

const HARNESS: Harness = "zep";

export interface ZepMessage {
  uuid?: string;
  id?: string;
  role: string;
  content: string;
  created_at?: string;
  timestamp?: string;
  metadata?: Record<string, unknown>;
}

export interface ZepThread {
  uuid?: string;
  id?: string;
  user_id?: string;
  created_at?: string;
  messages: ZepMessage[];
  metadata?: Record<string, unknown>;
}

export class ZepAdapter implements ContextAdapter {
  readonly harness: Harness = HARNESS;
  private apiUrl?: string;
  private apiKey?: string;
  private localDir?: string;

  constructor(opts?: { apiUrl?: string; apiKey?: string; localDir?: string }) {
    this.apiUrl = opts?.apiUrl ?? process.env.ZEP_API_URL;
    this.apiKey = opts?.apiKey ?? process.env.ZEP_API_KEY;
    this.localDir = opts?.localDir;
  }

  capabilities() {
    return {
      sessions: true as const,
      turns: true as const,
      search: false as const,
      topology: false as const,
    };
  }

  private loadLocalThreads(): ZepThread[] {
    if (!this.localDir || !existsSync(this.localDir)) return [];
    try {
      const threadsFile = join(this.localDir, "threads.json");
      if (existsSync(threadsFile)) {
        const raw = JSON.parse(readFileSync(threadsFile, "utf8"));
        return Array.isArray(raw) ? raw : raw.threads ?? [];
      }
    } catch {
      // ignore
    }
    return [];
  }

  async listSessions(): Promise<Session[]> {
    // 1. Check local fixture/export
    const local = this.loadLocalThreads();
    if (local.length > 0) {
      return local.map((t) => {
        const id = t.uuid ?? t.id ?? "zep-thread";
        return {
          id,
          harness: HARNESS,
          agentId: `${HARNESS}:${t.user_id ?? "user"}`,
          projectId: (t.metadata?.project as string) ?? "zep-memory",
          workspace: "zep-lake",
          startedAt: t.created_at ?? new Date().toISOString(),
          sourcePath: join(this.localDir ?? "", "threads.json"),
        };
      });
    }

    // 2. Query live Zep REST API if credentials exist
    if (this.apiUrl) {
      try {
        const res = await fetch(`${this.apiUrl.replace(/\/$/, "")}/api/v2/sessions`, {
          headers: {
            Authorization: `Api-Key ${this.apiKey ?? ""}`,
          },
          signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) return [];
        const body = (await res.json()) as { sessions?: { session_id: string; created_at: string }[] };
        const list = body.sessions ?? [];
        return list.map((s) => ({
          id: s.session_id,
          harness: HARNESS,
          agentId: `${HARNESS}:remote`,
          projectId: "zep-cloud",
          workspace: "zep-lake",
          startedAt: s.created_at,
          sourcePath: `${this.apiUrl}/sessions/${s.session_id}`,
        }));
      } catch {
        return [];
      }
    }

    return [];
  }

  async listTurns(sessionId: string): Promise<Turn[]> {
    const local = this.loadLocalThreads();
    const thread = local.find((t) => (t.uuid ?? t.id) === sessionId);
    if (thread) {
      return thread.messages.map((m, idx) => {
        const content = truncate(m.content.trim());
        const rawRole = m.role.toLowerCase();
        const role =
          rawRole.includes("user") || rawRole.includes("human") ? "user"
          : rawRole.includes("assistant") || rawRole.includes("ai") ? "assistant"
          : rawRole.includes("system") ? "system"
          : "unknown";
        const key = m.uuid ?? m.id ?? String(idx);
        return {
          id: makeTurnId(HARNESS, sessionId, key),
          sessionId,
          harness: HARNESS,
          timestamp: m.created_at ?? m.timestamp ?? thread.created_at ?? new Date().toISOString(),
          role,
          content,
          raw: m.metadata ?? {},
          fileRefs: extractFileRefs(content),
          seq: idx,
        };
      });
    }

    if (this.apiUrl) {
      try {
        const res = await fetch(`${this.apiUrl.replace(/\/$/, "")}/api/v2/sessions/${sessionId}/messages`, {
          headers: { Authorization: `Api-Key ${this.apiKey ?? ""}` },
          signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) throw new Error(`Zep API error: ${res.status}`);
        const body = (await res.json()) as { messages?: ZepMessage[] };
        const msgs = body.messages ?? [];
        return msgs.map((m, idx) => {
          const content = truncate(m.content.trim());
          const role = m.role.toLowerCase().includes("user") ? "user" : "assistant";
          const key = m.uuid ?? m.id ?? String(idx);
          return {
            id: makeTurnId(HARNESS, sessionId, key),
            sessionId,
            harness: HARNESS,
            timestamp: m.created_at ?? new Date().toISOString(),
            role,
            content,
            raw: m.metadata ?? {},
            fileRefs: extractFileRefs(content),
            seq: idx,
          };
        });
      } catch (e) {
        throw new Error(`zep session not found: ${sessionId}`);
      }
    }

    throw new Error(`zep session not found: ${sessionId}`);
  }

  async getTurn(sessionId: string, turnId: string): Promise<Turn> {
    const turns = await this.listTurns(sessionId);
    const hit = turns.find((t) => t.id === turnId);
    if (!hit) throw new Error(`turn not found: ${turnId}`);
    return hit;
  }

  async getCursor(): Promise<Record<string, FileCursor>> {
    if (this.localDir && existsSync(join(this.localDir, "threads.json"))) {
      const p = join(this.localDir, "threads.json");
      return { [p]: { mtimeMs: Date.now(), offsetBytes: 0 } };
    }
    return {};
  }
}
