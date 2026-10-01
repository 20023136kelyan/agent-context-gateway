/**
 * Turning items into the text an agent sees. Everything here goes straight into a
 * model's context, so it is sanitised, capped and stable: the same items always
 * produce the same text, which keeps the agent's prompt cache intact.
 */
import { formatAnchor, TEXT_LIMIT, type Item } from "../store/items.js";
import { rankItems } from "./select.js";

/**
 * Fixed text for the agent's session context. It must not vary between sessions or
 * during one: anything that changes early context breaks the provider's prompt cache.
 */
export const SESSION_EXPLANATION =
  "This repository has Bifröst: notes marked BIFRÖST that appear after a tool result are the team's recorded decisions and past corrections about that file, added by the team's own tooling. Follow them unless the user's request says otherwise.";

/** Strip control and bidirectional-override characters, collapse whitespace, cap length. */
export function sanitize(text: string, limit = TEXT_LIMIT): string {
  const clean = String(text)
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return clean.length > limit ? `${clean.slice(0, limit - 1)}…` : clean;
}

/** "3d", "5h", "12m", or "now": coarse on purpose, so the text changes rarely. */
export function age(from: string, now: Date): string {
  const ms = now.getTime() - Date.parse(from);
  if (!(ms > 0)) return "now";
  const m = Math.floor(ms / 60_000);
  if (m < 60) return m < 1 ? "now" : `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

export function formatLine(item: Item, now: Date): string {
  const meta = [age(item.createdAt, now), item.source.author].filter(Boolean).map((s) => sanitize(String(s), 24)).join(" · ");
  return `  ${sanitize(item.type, 16).toUpperCase().padEnd(10)} ${meta ? `${meta}  ` : ""}${sanitize(item.text)}`;
}

export interface FormatOptions {
  maxItems?: number;
  budgetChars?: number;
  now?: Date;
}

/**
 * Items grouped under a header per place, best first, within a count and a
 * character budget. Returns the text and the ids that made it in.
 */
export function formatItems(items: Item[], { maxItems = 3, budgetChars = 900, now = new Date() }: FormatOptions = {}): { text: string; shown: string[] } {
  const groups = new Map<string, { place: string; lines: string[]; ids: string[] }>();
  const shown: string[] = [];
  let used = 0;
  for (const item of rankItems(items)) {
    if (shown.length >= maxItems) break;
    const place = formatAnchor(item.anchor);
    const group = groups.get(place);
    const header = `BIFRÖST ${sanitize(place, 160)}`;
    const line = formatLine(item, now);
    const cost = line.length + 1 + (group ? 0 : header.length + 1);
    if (used + cost > budgetChars) continue;
    used += cost;
    if (group) {
      group.lines.push(line);
      group.ids.push(item.id);
    } else groups.set(place, { place: header, lines: [line], ids: [item.id] });
    shown.push(item.id);
  }
  const text = [...groups.values()].flatMap((g) => [g.place, ...g.lines]).join("\n");
  return { text, shown };
}
