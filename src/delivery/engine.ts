/**
 * The delivery engine: given a tool call or a session start, decides which items an
 * agent sees. Holds each repository's active items in memory (reloaded when the
 * store changes) and what each session has already been shown. Client shims and the
 * daemon call it; it never throws on bad input, it returns nothing to show.
 */
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import type { Item } from "../store/items.js";
import type { Delivery, ItemStore } from "../store/store.js";
import { formatItems, SESSION_EXPLANATION, type FormatOptions } from "./format.js";
import { placesFromToolCall } from "./places.js";
import { matchItems } from "./select.js";

/** Tool names (Claude Code vocabulary) that change files. */
export const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", "apply_patch"]);
/** Types shown again when the agent edits a place, even if it already saw them while reading. */
export const REPEAT_ON_EDIT = new Set(["warning", "known-issue"]);

export interface ToolEvent {
  cwd: string;
  session: string;
  client: string;
  /** Claude Code tool name; client shims translate theirs. */
  tool: string;
  input: unknown;
}

export interface SessionEvent {
  cwd: string;
  session: string;
  client: string;
}

export interface Decision {
  text: string;
  shown: string[];
}

interface SessionState {
  shown: Set<string>;
  shownOnEdit: Set<string>;
  lastSeen: number;
}

export interface EngineOptions extends Omit<FormatOptions, "now"> {
  now?: () => Date;
  /** Project items shown at session start, at most. */
  maxProjectItems?: number;
  /** Repository root for a working directory; defaults to `git rev-parse --show-toplevel`. */
  repoFor?: (cwd: string) => string;
  /** Forget a session's state after this long without activity. */
  sessionTtlMs?: number;
}

export function gitRoot(cwd: string): string {
  const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", timeout: 2000 });
  return r.status === 0 && r.stdout.trim() ? resolve(r.stdout.trim()) : resolve(cwd);
}

export class DeliveryEngine {
  private items = new Map<string, { token: string; items: Item[]; known: string[] }>();
  private roots = new Map<string, string>();
  private sessions = new Map<string, SessionState>();
  private now: () => Date;

  constructor(
    private store: ItemStore,
    private opts: EngineOptions = {},
  ) {
    this.now = opts.now ?? (() => new Date());
  }

  repoFor(cwd: string): string {
    let root = this.roots.get(cwd);
    if (!root) {
      root = (this.opts.repoFor ?? gitRoot)(cwd);
      this.roots.set(cwd, root);
    }
    return root;
  }

  private active(repo: string): { items: Item[]; known: string[] } {
    const token = this.store.changeToken();
    const cached = this.items.get(repo);
    if (cached && cached.token === token) return cached;
    const items = this.store.activeAt(repo, this.now());
    const known = [...new Set(items.flatMap((i) => (i.anchor.kind === "project" ? [] : [i.anchor.path])))];
    const next = { token, items, known };
    this.items.set(repo, next);
    return next;
  }

  private state(session: string): SessionState {
    const t = this.now().getTime();
    const ttl = this.opts.sessionTtlMs ?? 24 * 3600_000;
    for (const [k, s] of this.sessions) if (t - s.lastSeen > ttl) this.sessions.delete(k);
    let s = this.sessions.get(session);
    if (!s) {
      s = { shown: new Set(), shownOnEdit: new Set(), lastSeen: t };
      this.sessions.set(session, s);
    }
    s.lastSeen = t;
    return s;
  }

  private format(items: Item[], maxItems?: number): Decision {
    return formatItems(items, { maxItems: maxItems ?? this.opts.maxItems ?? 3, budgetChars: this.opts.budgetChars ?? 900, now: this.now() });
  }

  private log(d: Omit<Delivery, "at">): void {
    try {
      this.store.logDelivery({ at: this.now().toISOString(), ...d });
    } catch {
      /* the log never blocks delivery */
    }
  }

  /** Items for the places a tool call touched that this session has not been shown yet. */
  onTool(e: ToolEvent): Decision {
    try {
      const repo = this.repoFor(e.cwd);
      const { items, known } = this.active(repo);
      const places = placesFromToolCall(e.tool, e.input, repo, known);
      const matched = matchItems(items, places);
      const st = this.state(e.session);
      const isEdit = EDIT_TOOLS.has(e.tool);
      const fresh = matched.filter((i) => !st.shown.has(i.id) || (isEdit && REPEAT_ON_EDIT.has(i.type) && !st.shownOnEdit.has(i.id)));
      const out = fresh.length ? this.format(fresh) : { text: "", shown: [] };
      for (const id of out.shown) {
        st.shown.add(id);
        if (isEdit) st.shownOnEdit.add(id);
      }
      this.log({ repo, session: e.session, client: e.client, event: "tool", tool: e.tool, places: places.map((p) => p.path), matched: matched.map((i) => i.id), shown: out.shown, chars: out.text.length });
      return out;
    } catch {
      return { text: "", shown: [] };
    }
  }

  /**
   * Context for the start of a session: the fixed explanation, then the project's
   * own items. Delivered once, early, and never changed afterwards.
   */
  onSessionStart(e: SessionEvent): Decision {
    try {
      const repo = this.repoFor(e.cwd);
      const project = this.active(repo).items.filter((i) => i.anchor.kind === "project");
      const st = this.state(e.session);
      const out = project.length ? this.format(project, this.opts.maxProjectItems ?? 5) : { text: "", shown: [] };
      for (const id of out.shown) st.shown.add(id);
      const text = out.text ? `${SESSION_EXPLANATION}\n\n${out.text}` : SESSION_EXPLANATION;
      this.log({ repo, session: e.session, client: e.client, event: "session", places: [], matched: project.map((i) => i.id), shown: out.shown, chars: text.length });
      return { text, shown: out.shown };
    } catch {
      return { text: SESSION_EXPLANATION, shown: [] };
    }
  }
}
