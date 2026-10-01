/**
 * Reads notes in the experiment kit's format ({ notes: [{ id, type, anchor: { path,
 * symbol?, lines? }, text, author?, age? }] }) as new items. A path ending in "/" is a
 * folder; an empty path or "." is the whole project.
 */
import { readFileSync } from "node:fs";
import { ItemError, type Anchor, type ItemType, type NewItem } from "./items.js";

interface KitNote {
  id?: string;
  type: string;
  anchor: { path?: string; symbol?: string; lines?: [number, number] };
  text: string;
  author?: string;
}

function anchorOf(a: KitNote["anchor"]): Anchor {
  const path = (a.path ?? "").trim();
  if (!path || path === "." || path === "/") return { kind: "project" };
  if (path.endsWith("/")) return { kind: "folder", path };
  if (a.symbol) return { kind: "symbol", path, symbol: a.symbol, ...(a.lines ? { lines: a.lines } : {}) };
  return { kind: "file", path, ...(a.lines ? { lines: a.lines } : {}) };
}

export function kitNotesToItems(data: unknown, repo: string, source: NewItem["source"] = { kind: "hand" }): NewItem[] {
  const notes = Array.isArray(data) ? data : (data as { notes?: unknown })?.notes;
  if (!Array.isArray(notes)) throw new ItemError("expected { notes: [...] }");
  return (notes as KitNote[]).map((n) => ({
    repo,
    type: n.type as ItemType,
    text: n.text,
    anchor: anchorOf(n.anchor ?? {}),
    source: { ...source, ...(n.author ? { author: n.author } : {}) },
    evidence: n.id ? [{ kind: "note" as const, ref: `imported:${n.id}` }] : [],
  }));
}

export function readKitNotes(file: string, repo: string, source?: NewItem["source"]): NewItem[] {
  return kitNotesToItems(JSON.parse(readFileSync(file, "utf8")), repo, source);
}
