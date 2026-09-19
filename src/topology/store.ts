/**
 * P2b topology — parent/child/sibling links between sessions.
 * Neither Claude Code nor Codex exposes agent lineage in native histories
 * (Claude parentUuid = message threading, not agent topology), so links are
 * explicit: recorded via CLI/hooks, stored in topology.json (disposable
 * derived state — delete it and scopes fall back to project search).
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

export interface SessionRef {
  harness: string;
  sessionId: string;
}

export interface TopologyLink {
  parent: SessionRef;
  child: SessionRef;
  createdAt: string;
}

const key = (r: SessionRef) => `${r.harness}:${r.sessionId}`;

export class TopologyStore {
  private links: TopologyLink[] = [];
  constructor(private path: string) {
    try {
      if (existsSync(path)) {
        const raw = JSON.parse(readFileSync(path, "utf8")) as { links?: TopologyLink[] };
        if (Array.isArray(raw.links)) this.links = raw.links;
      }
    } catch {
      this.links = [];
    }
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify({ version: 1, links: this.links }, null, 2));
  }

  link(parent: SessionRef, child: SessionRef): TopologyLink {
    if (key(parent) === key(child)) throw new Error("bad_request: session cannot parent itself");
    const existing = this.links.find((l) => key(l.parent) === key(parent) && key(l.child) === key(child));
    if (existing) return existing;
    const link: TopologyLink = { parent, child, createdAt: new Date().toISOString() };
    this.links.push(link);
    this.save();
    return link;
  }

  unlink(parent: SessionRef, child: SessionRef): boolean {
    const before = this.links.length;
    this.links = this.links.filter((l) => !(key(l.parent) === key(parent) && key(l.child) === key(child)));
    if (this.links.length !== before) this.save();
    return this.links.length !== before;
  }

  parentsOf(ref: SessionRef): SessionRef[] {
    return this.links.filter((l) => key(l.child) === key(ref)).map((l) => l.parent);
  }

  childrenOf(ref: SessionRef): SessionRef[] {
    return this.links.filter((l) => key(l.parent) === key(ref)).map((l) => l.child);
  }

  siblingsOf(ref: SessionRef): SessionRef[] {
    const parents = new Set(this.parentsOf(ref).map(key));
    return this.links
      .filter((l) => parents.has(key(l.parent)) && key(l.child) !== key(ref))
      .map((l) => l.child);
  }

  all(): TopologyLink[] {
    return [...this.links];
  }

  touching(ref: SessionRef): TopologyLink[] {
    return this.links.filter((l) => key(l.parent) === key(ref) || key(l.child) === key(ref));
  }
}

export function defaultTopologyPath(stateDir?: string): string {
  // Was missing the CONTEXT_GATEWAY_STATE fallback that all six sibling stores
  // have. Only reachable by direct callers, since app.ts passes the value
  // explicitly — which is why it never bit.
  const base = stateDir ?? process.env.CONTEXT_GATEWAY_STATE ?? `${process.env.HOME ?? "/tmp"}/.context-gateway`;
  return join(base, "topology.json");
}

/** "auto" scope routing from query wording (spec §22). */
export function routeAutoScope(query: string): "parent" | "children" | "siblings" | null {
  const q = query.toLowerCase();
  if (/\bparent\b/.test(q)) return "parent";
  if (/\bchild|siblings?\b/.test(q)) return q.includes("sibling") ? "siblings" : "children";
  return null;
}
