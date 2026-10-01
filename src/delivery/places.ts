/**
 * Places a tool call touches: repository-relative paths, with a line range when the
 * call says which lines it reads. Client shims translate their own tool names and
 * arguments to the Claude Code shape first (`fromOpenCodeCall`, …).
 */
import { isAbsolute, relative, resolve, sep } from "node:path";

export interface Place {
  path: string;
  lines?: [number, number];
}

/** Repository-relative POSIX path, or null when the path is outside the root. */
export function toRepoPath(path: unknown, root: string): string | null {
  if (!path || typeof path !== "string") return null;
  const abs = isAbsolute(path) ? path : resolve(root, path);
  const rel = relative(root, abs);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel.split(sep).join("/");
}

const OPENCODE_TOOLS: Record<string, string> = {
  read: "Read", edit: "Edit", write: "Write", multiedit: "MultiEdit", bash: "Bash", grep: "Grep", glob: "Glob", list: "LS", patch: "apply_patch", apply_patch: "apply_patch",
};

/** OpenCode tool calls (camelCase arguments) → Claude Code names and argument keys. */
export function fromOpenCodeCall(tool: string, args: unknown): { tool: string; input: Record<string, unknown> } {
  const a = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  const input: Record<string, unknown> = { ...a };
  if (typeof a.filePath === "string") input.file_path = a.filePath;
  if (typeof a.oldString === "string") input.old_string = a.oldString;
  if (typeof a.newString === "string") input.new_string = a.newString;
  if (typeof a.patchText === "string") input.patch = a.patchText;
  return { tool: OPENCODE_TOOLS[tool] ?? tool, input };
}

/**
 * `knownPaths` are the anchor paths items use; a shell command or patch that mentions
 * one touches it. A folder anchor ("src/exports/") also matches its bare name.
 */
export function placesFromToolCall(tool: string, input: unknown, root: string, knownPaths: string[] = []): Place[] {
  const out: Place[] = [];
  const add = (p: unknown, lines?: [number, number]) => {
    const rel = toRepoPath(p, root);
    if (rel && !out.some((o) => o.path === rel)) out.push(lines ? { path: rel, lines } : { path: rel });
  };
  if (!input || typeof input !== "object") return out;
  const i = input as Record<string, unknown>;
  if (typeof i.file_path === "string") {
    const offset = i.offset;
    const limit = i.limit;
    add(i.file_path, Number.isInteger(offset) ? [offset as number, (offset as number) + (Number.isInteger(limit) ? (limit as number) : 2000)] : undefined);
  }
  if (typeof i.notebook_path === "string") add(i.notebook_path);
  if (typeof i.path === "string" && tool !== "Glob") add(i.path);
  const text = typeof i.command === "string" ? i.command : typeof i.patch === "string" ? i.patch : typeof i.input === "string" ? i.input : null;
  if (text) {
    for (const kp of knownPaths) {
      const bare = kp.endsWith("/") ? kp.slice(0, -1) : kp;
      if (text.includes(bare)) add(bare);
    }
  }
  return out;
}
