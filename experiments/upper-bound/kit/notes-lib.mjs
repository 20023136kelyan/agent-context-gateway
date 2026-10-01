/**
 * Shared note logic for the delivery hook and the MCP server.
 *
 * A notes file is { source, notes: [{ id, type, anchor: { path, symbol?, lines? }, text, author?, age? }] }.
 * Paths are repo-relative. Matching is by file path; `lines` ([start, end]) narrows a match
 * when the tool call says which lines it touches. A path ending in "/" anchors a note to a
 * folder: it matches anything under it, including a file being created there, and the
 * folder itself.
 */
import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

export const TYPE_ORDER = ["warning", "known-issue", "in-progress", "decision", "preference", "open-thread", "discovery", "how-to"];
export const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", "apply_patch"]);
export const REPEAT_ON_EDIT = new Set(["warning", "known-issue"]);
export const TEXT_LIMIT = 280;

export function loadNotes(file) {
  const data = JSON.parse(readFileSync(file, "utf8"));
  const notes = Array.isArray(data) ? data : data.notes;
  if (!Array.isArray(notes)) throw new Error(`${file}: expected { notes: [...] }`);
  return notes.filter((n) => n && typeof n.id === "string" && n.anchor && typeof n.anchor.path === "string" && typeof n.text === "string");
}

/** Repo-relative POSIX path, or null when the path is outside the root. */
export function toRepoPath(p, root) {
  if (!p || typeof p !== "string") return null;
  const abs = isAbsolute(p) ? p : resolve(root, p);
  const rel = relative(root, abs);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel.split(sep).join("/");
}

/**
 * The places a tool call touches: repo-relative paths, plus the line range when known.
 * Handles Claude Code (Read/Edit/Write/MultiEdit/Grep/Glob/Bash) and generic { path } inputs.
 */
/**
 * OpenCode tool calls → the Claude Code names and argument keys the rest of the kit uses.
 * OpenCode: read/edit/write/multiedit {filePath,…}, patch/apply_patch {patchText}, bash, grep, glob, list.
 */
const OPENCODE_TOOLS = { read: "Read", edit: "Edit", write: "Write", multiedit: "MultiEdit", bash: "Bash", grep: "Grep", glob: "Glob", list: "LS", patch: "apply_patch", apply_patch: "apply_patch" };
export function fromOpenCodeCall(tool, args) {
  const a = args && typeof args === "object" ? args : {};
  const input = { ...a };
  if (typeof a.filePath === "string") input.file_path = a.filePath;
  if (typeof a.oldString === "string") input.old_string = a.oldString;
  if (typeof a.newString === "string") input.new_string = a.newString;
  if (typeof a.patchText === "string") input.patch = a.patchText;
  return { tool: OPENCODE_TOOLS[tool] ?? tool, input };
}

export function placesFromToolCall(toolName, input, root, knownPaths = []) {
  const out = [];
  const add = (p, lines) => {
    const rel = toRepoPath(p, root);
    if (rel && !out.some((o) => o.path === rel)) out.push({ path: rel, lines });
  };
  if (!input || typeof input !== "object") return out;
  if (typeof input.file_path === "string") {
    let lines;
    if (Number.isInteger(input.offset)) lines = [input.offset, input.offset + (Number.isInteger(input.limit) ? input.limit : 2000)];
    add(input.file_path, lines);
  }
  if (typeof input.notebook_path === "string") add(input.notebook_path);
  if (typeof input.path === "string" && toolName !== "Glob") add(input.path);
  const text = typeof input.command === "string" ? input.command : typeof input.patch === "string" ? input.patch : typeof input.input === "string" ? input.input : null;
  if (text) {
    for (const kp of knownPaths) if (text.includes(kp)) add(kp);
  }
  return out;
}

export function anchorCovers(anchor, path) {
  if (!anchor.endsWith("/")) return anchor === path;
  return path.startsWith(anchor) || path === anchor.slice(0, -1);
}

export function matchNotes(notes, places) {
  const hits = [];
  for (const note of notes) {
    for (const place of places) {
      if (!anchorCovers(note.anchor.path, place.path)) continue;
      const nl = note.anchor.lines;
      if (Array.isArray(nl) && place.lines && (nl[1] < place.lines[0] || nl[0] > place.lines[1])) continue;
      hits.push(note);
      break;
    }
  }
  return hits;
}

export function rankNotes(notes) {
  const rank = (t) => {
    const i = TYPE_ORDER.indexOf(t);
    return i === -1 ? TYPE_ORDER.length : i;
  };
  return [...notes].sort((a, b) => rank(a.type) - rank(b.type) || String(a.id).localeCompare(String(b.id)));
}

/** Strip control characters and cap length; notes go straight into model context. */
export function sanitize(text, limit = TEXT_LIMIT) {
  const clean = String(text).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, "").replace(/\s+/g, " ").trim();
  return clean.length > limit ? clean.slice(0, limit - 1) + "…" : clean;
}

export function formatLine(note) {
  const meta = [note.age, note.author].filter(Boolean).map((s) => sanitize(s, 24)).join(" · ");
  const type = sanitize(note.type ?? "note", 16).toUpperCase();
  return `  ${type.padEnd(9)} ${meta ? meta + "  " : ""}${sanitize(note.text)}`;
}

/**
 * Formats notes grouped by place, within a character budget and a note cap.
 * Returns { text, shown } where `shown` lists the ids that made it in.
 */
export function formatNotes(notes, { maxNotes = 3, budgetChars = 900 } = {}) {
  const byPlace = new Map();
  for (const n of rankNotes(notes)) {
    const key = n.anchor.symbol ? `${n.anchor.path} › ${n.anchor.symbol}` : n.anchor.path;
    if (!byPlace.has(key)) byPlace.set(key, []);
    byPlace.get(key).push(n);
  }
  const lines = [];
  const shown = [];
  let used = 0;
  for (const [place, group] of byPlace) {
    const header = `BIFRÖST ${sanitize(place, 160)}`;
    const pending = [];
    for (const n of group) {
      if (shown.length + pending.length >= maxNotes) break;
      const line = formatLine(n);
      const cost = line.length + 1 + (pending.length === 0 ? header.length + 1 : 0);
      if (used + cost > budgetChars) break;
      used += cost;
      pending.push({ n, line });
    }
    if (pending.length === 0) continue;
    lines.push(header, ...pending.map((p) => p.line));
    shown.push(...pending.map((p) => p.n.id));
    if (shown.length >= maxNotes) break;
  }
  return { text: lines.join("\n"), shown };
}
