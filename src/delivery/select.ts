/**
 * Which items apply to the places a tool call touched, and in what order.
 * Ranking: the most specific anchor first (symbol, file, folder, project), then type,
 * then the newest. Specificity first keeps a note written for this exact file ahead
 * of broad notes about its folder, which a type-first order let noise displace.
 */
import { ITEM_TYPES, type Anchor, type Item } from "../store/items.js";
import type { Place } from "./places.js";

/** Display and ranking order of types: what can hurt first. */
export const TYPE_ORDER = ["warning", "known-issue", "in-progress", "decision", "preference", "open-thread", "discovery", "how-to"] as const satisfies readonly (typeof ITEM_TYPES)[number][];

const SPECIFICITY: Record<Anchor["kind"], number> = { symbol: 0, file: 1, folder: 2, project: 3 };

function overlaps(a: [number, number] | undefined, b: [number, number] | undefined): boolean {
  return !a || !b || (a[0] <= b[1] && b[0] <= a[1]);
}

/** Does an item's anchor apply to a place? A folder covers everything under it and itself. */
export function covers(anchor: Anchor, place: Place): boolean {
  switch (anchor.kind) {
    case "project":
      return true;
    case "folder":
      return place.path.startsWith(anchor.path) || place.path === anchor.path.slice(0, -1);
    case "file":
    case "symbol":
      return anchor.path === place.path && overlaps(anchor.lines, place.lines);
  }
}

export function matchItems(items: Item[], places: Place[], { includeProject = false } = {}): Item[] {
  return items.filter((item) => (includeProject || item.anchor.kind !== "project") && places.some((p) => covers(item.anchor, p)));
}

export function rankItems(items: Item[]): Item[] {
  const typeRank = (t: string) => {
    const i = (TYPE_ORDER as readonly string[]).indexOf(t);
    return i === -1 ? TYPE_ORDER.length : i;
  };
  return [...items].sort(
    (a, b) =>
      SPECIFICITY[a.anchor.kind] - SPECIFICITY[b.anchor.kind] ||
      typeRank(a.type) - typeRank(b.type) ||
      b.createdAt.localeCompare(a.createdAt) ||
      a.id.localeCompare(b.id),
  );
}
