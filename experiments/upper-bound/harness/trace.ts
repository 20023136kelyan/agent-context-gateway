/**
 * Agent traces → normalized steps → text a note-writing model reads.
 *
 * Supported inputs (one JSON object per line):
 *  - Claude Code `-p --output-format stream-json --verbose` output
 *  - Claude Code session files (~/.claude/projects/<slug>/<id>.jsonl): same message shape
 *  - Codex `exec --json` events (best effort; the format is not verified here)
 *  - `{ "type": "bifrost.outcome", ... }` lines the harness appends after grading a seed run
 */

export type Step =
  | { kind: "prompt"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool_call"; id?: string; tool: string; input: Record<string, unknown> }
  | { kind: "tool_result"; id?: string; text: string; isError: boolean }
  | { kind: "outcome"; text: string };

type Json = Record<string, unknown>;

function asText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === "string" ? c : c && typeof c === "object" && "text" in c ? String((c as Json).text ?? "") : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function fromClaudeMessage(obj: Json, steps: Step[]): boolean {
  const type = obj.type;
  const message = obj.message as Json | undefined;
  if ((type !== "user" && type !== "assistant") || !message) return false;
  const content = message.content;
  if (type === "user") {
    if (typeof content === "string") {
      steps.push({ kind: "prompt", text: content });
      return true;
    }
    for (const block of (content as Json[]) ?? []) {
      if (block?.type === "tool_result") {
        steps.push({ kind: "tool_result", id: String(block.tool_use_id ?? ""), text: asText(block.content), isError: block.is_error === true });
      } else if (block?.type === "text" && typeof block.text === "string" && !obj.isMeta) {
        steps.push({ kind: "prompt", text: block.text });
      }
    }
    return true;
  }
  for (const block of (content as Json[]) ?? []) {
    if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
      steps.push({ kind: "assistant", text: block.text });
    } else if (block?.type === "tool_use") {
      steps.push({ kind: "tool_call", id: String(block.id ?? ""), tool: String(block.name ?? "tool"), input: (block.input as Json) ?? {} });
    }
  }
  return true;
}

function fromCodexEvent(obj: Json, steps: Step[]): boolean {
  const item = (obj.item ?? obj.msg) as Json | undefined;
  if (!item || typeof item !== "object") return false;
  if (obj.type !== "item.completed" && obj.type !== "item.started" && !obj.msg) return false;
  if (obj.type === "item.started") return true;
  switch (item.type) {
    case "agent_message":
      steps.push({ kind: "assistant", text: String(item.text ?? "") });
      return true;
    case "command_execution":
      steps.push({ kind: "tool_call", tool: "Bash", input: { command: item.command } });
      steps.push({ kind: "tool_result", text: String(item.aggregated_output ?? ""), isError: typeof item.exit_code === "number" && item.exit_code !== 0 });
      return true;
    case "file_change":
      steps.push({ kind: "tool_call", tool: "Edit", input: { changes: item.changes } });
      return true;
    case "mcp_tool_call":
      steps.push({ kind: "tool_call", tool: `mcp:${String(item.tool ?? "")}`, input: (item.arguments as Json) ?? {} });
      return true;
    default:
      return true;
  }
}

export function parseTrace(text: string, prompt?: string): Step[] {
  const steps: Step[] = [];
  if (prompt) steps.push({ kind: "prompt", text: prompt });
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let obj: Json;
    try {
      obj = JSON.parse(line) as Json;
    } catch {
      continue;
    }
    if (obj.type === "bifrost.outcome") {
      steps.push({ kind: "outcome", text: String(obj.text ?? JSON.stringify(obj.grade ?? obj)) });
      continue;
    }
    if (fromClaudeMessage(obj, steps)) continue;
    fromCodexEvent(obj, steps);
  }
  // A prompt given explicitly and repeated as the first user message is kept once.
  if (prompt && steps.length > 1 && steps[1].kind === "prompt" && steps[1].text.trim() === prompt.trim()) steps.splice(1, 1);
  return steps;
}

const SECRET_PATTERNS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[private key]"],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, "[secret]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[secret]"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, "[secret]"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "[secret]"],
  [/\b(Bearer)\s+[A-Za-z0-9._~+/-]{20,}=*/g, "$1 [secret]"],
  [/\b((?:api[_-]?key|token|secret|password|passwd)\s*[:=]\s*)["']?[^\s"',;]{8,}/gi, "$1[secret]"],
];

export function scrub(text: string): string {
  let out = text;
  for (const [re, rep] of SECRET_PATTERNS) out = out.replace(re, rep);
  return out;
}

function clip(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max)} […${t.length - max} more chars]` : t;
}

function firstLine(text: string, max = 200): string {
  return clip(text.split("\n").find((l) => l.trim()) ?? "", max);
}

function describeCall(step: Extract<Step, { kind: "tool_call" }>, max: number): string {
  const i = step.input;
  const path = (i.file_path ?? i.notebook_path ?? i.path) as string | undefined;
  if (step.tool === "Bash" && typeof i.command === "string") return `Bash: ${clip(i.command, max)}`;
  if ((step.tool === "Edit" || step.tool === "MultiEdit") && path) {
    const old = typeof i.old_string === "string" ? firstLine(i.old_string, 120) : "";
    const neu = typeof i.new_string === "string" ? clip(i.new_string, max) : "";
    return `${step.tool} ${path}${old ? ` (replacing: ${old})` : ""}${neu ? `\n    new: ${neu}` : ""}`;
  }
  if (step.tool === "Write" && path) return `Write ${path}${typeof i.content === "string" ? `\n    content: ${clip(i.content, max)}` : ""}`;
  if (path) return `${step.tool} ${path}${i.pattern ? ` pattern=${String(i.pattern)}` : ""}`;
  return `${step.tool} ${clip(JSON.stringify(i), max)}`;
}

/**
 * Full rendering: the whole trace, with each tool result capped at `resultChars`
 * (stated in the output) and secrets scrubbed.
 */
export function renderFull(steps: Step[], { resultChars = 2000, callChars = 4000 } = {}): string {
  const out: string[] = [];
  for (const s of steps) {
    if (s.kind === "prompt") out.push(`USER: ${s.text.trim()}`);
    else if (s.kind === "assistant") out.push(`AGENT: ${s.text.trim()}`);
    else if (s.kind === "tool_call") out.push(`CALL ${describeCall(s, callChars)}`);
    else if (s.kind === "tool_result") out.push(`${s.isError ? "ERROR" : "RESULT"}: ${clip(s.text, resultChars)}`);
    else out.push(`OUTCOME (after the session): ${s.text.trim()}`);
  }
  return scrub(out.join("\n\n"));
}

/**
 * Digest rendering: what a privacy-preserving pipeline would send upstream.
 * One line per tool call with its outcome, short excerpts of intent, the final outcome.
 */
export function renderDigest(steps: Step[]): string {
  const out: string[] = [];
  for (let k = 0; k < steps.length; k++) {
    const s = steps[k];
    if (s.kind === "prompt") out.push(`intent: ${clip(s.text, 500)}`);
    else if (s.kind === "assistant") out.push(`agent: ${clip(s.text, 300)}`);
    else if (s.kind === "tool_call") {
      const next = steps[k + 1];
      const result = next && next.kind === "tool_result" ? next : undefined;
      const status = result ? (result.isError ? `error: ${firstLine(result.text)}` : "ok") : "";
      out.push(`- ${describeCall(s, 160).split("\n")[0]}${status ? ` → ${status}` : ""}`);
      if (result) k++;
    } else if (s.kind === "tool_result") {
      if (s.isError) out.push(`  error: ${firstLine(s.text)}`);
    } else out.push(`outcome: ${clip(s.text, 1500)}`);
  }
  return scrub(out.join("\n"));
}

/** Repo-relative paths the trace touched through file tools. */
export function touchedPaths(steps: Step[], root?: string): string[] {
  const set = new Set<string>();
  for (const s of steps) {
    if (s.kind !== "tool_call") continue;
    const p = (s.input.file_path ?? s.input.notebook_path ?? s.input.path) as string | undefined;
    if (typeof p !== "string") continue;
    let rel = p;
    if (root && rel.startsWith(root)) rel = rel.slice(root.length).replace(/^\/+/, "");
    set.add(rel.replace(/^\.\//, ""));
  }
  return [...set];
}
