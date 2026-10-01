/**
 * Bifröst items: what agents learned, decided or were told, anchored to a place in
 * a repository and valid for a span of time (architecture §4.3, §5).
 */

export const ITEM_TYPES = ["warning", "known-issue", "in-progress", "decision", "preference", "open-thread", "discovery", "how-to"] as const;
export type ItemType = (typeof ITEM_TYPES)[number];

/** Longest text an item may carry; delivery puts it straight into an agent's context. */
export const TEXT_LIMIT = 280;

/**
 * Where an item applies, from broadest to narrowest. Paths are repository-relative
 * POSIX paths; a folder path ends in "/".
 */
export type Anchor =
  | { kind: "project" }
  | { kind: "folder"; path: string }
  | { kind: "file"; path: string; lines?: [number, number] }
  | { kind: "symbol"; path: string; symbol: string; lines?: [number, number] };

export type ItemStatus = "active" | "pending-review" | "retired";

/** What an item rests on: the session, outcome or message it came from. */
export interface Evidence {
  kind: "session" | "outcome" | "message" | "commit" | "note";
  ref: string;
  detail?: string;
  at?: string;
}

export interface ItemSource {
  /** hand: written by a person; generated: extracted by the service; correction: from a confirm/dispute/correct event */
  kind: "hand" | "generated" | "correction";
  author?: string;
}

export interface Item {
  id: string;
  /** Repository the item belongs to (its root path or remote URL). */
  repo: string;
  type: ItemType;
  text: string;
  anchor: Anchor;
  evidence: Evidence[];
  source: ItemSource;
  /** 0–1: how sure the pipeline is that the item holds. Hand-written items start at 1. */
  confidence: number;
  status: ItemStatus;
  validFrom: string;
  validUntil?: string;
  supersededBy?: string;
  votes: { up: number; down: number };
  createdAt: string;
  updatedAt: string;
}

export interface NewItem {
  repo: string;
  type: ItemType;
  text: string;
  anchor: Anchor;
  evidence?: Evidence[];
  source: ItemSource;
  confidence?: number;
  status?: ItemStatus;
  validFrom?: string;
}

export class ItemError extends Error {}

/** Repository-relative POSIX path; rejects absolute paths and paths that leave the repository. */
export function normalizePath(path: string, folder = false): string {
  let p = path.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/{2,}/g, "/");
  if (!p || p === "." || p === "/") throw new ItemError("anchor path is empty; use a project anchor for the whole repository");
  if (p.startsWith("/") || /^[a-zA-Z]:\//.test(p)) throw new ItemError(`anchor path must be relative to the repository: ${path}`);
  if (p.split("/").includes("..")) throw new ItemError(`anchor path leaves the repository: ${path}`);
  if (folder) return p.endsWith("/") ? p : `${p}/`;
  if (p.endsWith("/")) throw new ItemError(`file anchor ends in "/": ${path}; use a folder anchor`);
  return p;
}

function normalizeLines(lines: [number, number] | undefined): [number, number] | undefined {
  if (!lines) return undefined;
  const [a, b] = lines;
  if (!Number.isInteger(a) || !Number.isInteger(b) || a < 1 || b < a) throw new ItemError(`bad line range: ${JSON.stringify(lines)}`);
  return [a, b];
}

export function normalizeAnchor(anchor: Anchor): Anchor {
  switch (anchor.kind) {
    case "project":
      return { kind: "project" };
    case "folder":
      return { kind: "folder", path: normalizePath(anchor.path, true) };
    case "file": {
      const lines = normalizeLines(anchor.lines);
      return lines ? { kind: "file", path: normalizePath(anchor.path), lines } : { kind: "file", path: normalizePath(anchor.path) };
    }
    case "symbol": {
      const symbol = anchor.symbol.trim();
      if (!symbol) throw new ItemError("symbol anchor has no symbol");
      const lines = normalizeLines(anchor.lines);
      const base = { kind: "symbol" as const, path: normalizePath(anchor.path), symbol };
      return lines ? { ...base, lines } : base;
    }
    default:
      throw new ItemError(`unknown anchor kind: ${(anchor as { kind: string }).kind}`);
  }
}

/** Parses the short form people type: "" or "." for the project, "src/exports/" for a folder, "src/a.ts#fn" for a symbol. */
export function parseAnchor(spec: string): Anchor {
  const s = spec.trim();
  if (s === "" || s === "." || s === "/") return { kind: "project" };
  const hash = s.indexOf("#");
  if (hash > 0) return normalizeAnchor({ kind: "symbol", path: s.slice(0, hash), symbol: s.slice(hash + 1) });
  if (s.endsWith("/")) return normalizeAnchor({ kind: "folder", path: s });
  return normalizeAnchor({ kind: "file", path: s });
}

export function formatAnchor(anchor: Anchor): string {
  switch (anchor.kind) {
    case "project":
      return "(project)";
    case "folder":
    case "file":
      return anchor.path;
    case "symbol":
      return `${anchor.path} › ${anchor.symbol}`;
  }
}

export function validateNewItem(input: NewItem): NewItem {
  if (!input.repo?.trim()) throw new ItemError("item has no repository");
  if (!ITEM_TYPES.includes(input.type)) throw new ItemError(`unknown item type: ${input.type}`);
  const text = input.text?.replace(/\s+/g, " ").trim() ?? "";
  if (!text) throw new ItemError("item text is empty");
  if (text.length > TEXT_LIMIT) throw new ItemError(`item text is ${text.length} characters; the limit is ${TEXT_LIMIT}`);
  const confidence = input.confidence ?? (input.source.kind === "hand" ? 1 : 0.5);
  if (!(confidence >= 0 && confidence <= 1)) throw new ItemError(`confidence must be between 0 and 1: ${confidence}`);
  return { ...input, repo: input.repo.trim(), text, anchor: normalizeAnchor(input.anchor), evidence: input.evidence ?? [], confidence };
}
