/**
 * Notes generator: an agent's trace (plus the graded outcome) → a model → Bifröst notes.
 *
 * Arms this feeds:
 *   C  strong model, full trace          --provider anthropic --input full
 *   D  open-weight model, full trace     --provider openai --input full   (OpenAI-compatible server)
 *   E  open-weight model, digest only    --provider openai --input digest
 *
 * Usage:
 *   tsx experiments/upper-bound/harness/generate.ts --task refresh-rotation \
 *     --trace results/<run>/seed/.../trace.jsonl --provider anthropic --input full \
 *     --out experiments/upper-bound/tasks/refresh-rotation/notes/gen-opus-full.json
 */
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { parseTrace, renderDigest, renderFull, type Step } from "./trace.js";

export const NOTE_TYPES = ["warning", "known-issue", "decision", "discovery", "how-to", "in-progress", "open-thread"] as const;

export const NOTES_JSON_SCHEMA = {
  type: "object",
  properties: {
    notes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          type: { type: "string", enum: [...NOTE_TYPES] },
          path: { type: "string", description: "Repository-relative path of the file the note belongs to" },
          symbol: { type: ["string", "null"], description: "Function, method or class the note is about, e.g. AuthClient.refreshSession; null for the whole file" },
          text: { type: "string", description: "The note itself, at most 280 characters" },
        },
        required: ["type", "path", "symbol", "text"],
        additionalProperties: false,
      },
    },
  },
  required: ["notes"],
  additionalProperties: false,
} as const;

const ModelNotes = z.object({
  notes: z.array(
    z.object({
      type: z.enum(NOTE_TYPES),
      path: z.string(),
      symbol: z.string().nullable().optional(),
      text: z.string(),
    }),
  ),
});

export const SYSTEM_PROMPT = `You maintain Bifröst, a shared log of short notes that coding agents see when they open or edit a file. You read the record of one agent's work session, including what happened after it (tests, incidents), and decide what a future agent working in the same places must know.

Write notes only for knowledge that will still be true and useful next time:
- constraints and pitfalls that are not obvious from the code (warning, known-issue)
- decisions and their reasons (decision)
- facts that were hard to find (discovery)
- how to do something correctly here (how-to)
Do not summarise the session, restate what the code plainly says, or give generic advice.

Each note:
- belongs to one file in the repository (use a path from the file list), and to a symbol when it is about one function or method
- is at most 280 characters, specific and self-contained
- states facts; if the session showed an approach fails, say what fails and why, and what works instead if that is known

Write between 0 and 5 notes. Return an empty list when nothing is worth keeping.`;

export function buildUserPrompt(traceText: string, repoFiles: string[], mode: "full" | "digest"): string {
  return [
    `Repository files:\n${repoFiles.map((f) => `- ${f}`).join("\n")}`,
    mode === "full"
      ? "Session record (tool results are cut at 2,000 characters each; secrets removed):"
      : "Session digest (one line per action; secrets removed):",
    traceText,
    `Respond with JSON: {"notes": [{"type", "path", "symbol", "text"}]}.`,
  ].join("\n\n");
}

export interface ModelCall {
  (req: { system: string; user: string; schema: typeof NOTES_JSON_SCHEMA }): Promise<{ json: unknown; usage?: Record<string, unknown>; model?: string }>;
}

export interface GeneratedNotes {
  source: string;
  generatedAt: string;
  trace?: string;
  input: "full" | "digest";
  usage?: Record<string, unknown>;
  dropped: { reason: string; note: unknown }[];
  notes: { id: string; type: string; anchor: { path: string; symbol?: string }; text: string; author: string; age: string }[];
}

export function validateNotes(raw: unknown, repoFiles: string[], idPrefix = "gen"): Pick<GeneratedNotes, "notes" | "dropped"> {
  const parsed = ModelNotes.safeParse(raw);
  if (!parsed.success) throw new Error(`model output does not match the notes schema: ${parsed.error.message}`);
  const files = new Set(repoFiles);
  const notes: GeneratedNotes["notes"] = [];
  const dropped: GeneratedNotes["dropped"] = [];
  for (const n of parsed.data.notes) {
    const path = n.path.replace(/^\.\//, "");
    if (!files.has(path)) {
      dropped.push({ reason: "path not in repository", note: n });
      continue;
    }
    const text = n.text.trim();
    if (!text) {
      dropped.push({ reason: "empty text", note: n });
      continue;
    }
    if (notes.length >= 5) {
      dropped.push({ reason: "more than 5 notes", note: n });
      continue;
    }
    notes.push({
      id: `${idPrefix}-${notes.length + 1}`,
      type: n.type,
      anchor: n.symbol ? { path, symbol: n.symbol } : { path },
      // Over-long notes are kept but cut, and counted, so the arm is not silently favoured.
      text: text.length > 280 ? `${text.slice(0, 279)}…` : text,
      author: "generated",
      age: "",
    });
    if (text.length > 280) dropped.push({ reason: "text cut to 280 characters", note: n });
  }
  return { notes, dropped };
}

export async function generateNotes(opts: {
  steps: Step[];
  repoFiles: string[];
  input: "full" | "digest";
  call: ModelCall;
  source: string;
  trace?: string;
}): Promise<GeneratedNotes> {
  const traceText = opts.input === "full" ? renderFull(opts.steps) : renderDigest(opts.steps);
  const user = buildUserPrompt(traceText, opts.repoFiles, opts.input);
  const { json, usage } = await opts.call({ system: SYSTEM_PROMPT, user, schema: NOTES_JSON_SCHEMA });
  const { notes, dropped } = validateNotes(json, opts.repoFiles);
  return { source: opts.source, generatedAt: new Date().toISOString(), trace: opts.trace, input: opts.input, usage, dropped, notes };
}

/** Anthropic Messages API with structured output and server-side refusal fallbacks. */
export function anthropicCall(model: string, effort: "low" | "medium" | "high" | "xhigh" | "max" = "high"): ModelCall {
  const client = new Anthropic();
  return async ({ system, user, schema }) => {
    const response = await client.beta.messages.create({
      model,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      thinking: { type: "adaptive" },
      output_config: { effort, format: { type: "json_schema", schema: schema as unknown as Record<string, unknown> } },
      system,
      messages: [{ role: "user", content: user }],
    });
    if (response.stop_reason === "refusal") throw new Error(`model refused: ${JSON.stringify(response.stop_details ?? null)}`);
    if (response.stop_reason === "max_tokens") throw new Error("model output hit max_tokens");
    const text = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    return { json: JSON.parse(text), usage: response.usage as unknown as Record<string, unknown>, model: response.model };
  };
}

/**
 * OpenAI-compatible chat completions, for open-weight models served by vLLM,
 * llama.cpp, SGLang or a hosted provider. Set OPENAI_BASE_URL and OPENAI_API_KEY.
 */
export function openaiCompatibleCall(model: string, { schema = true } = {}): ModelCall {
  const base = (process.env.OPENAI_BASE_URL ?? "http://localhost:8000/v1").replace(/\/$/, "");
  return async ({ system, user, schema: jsonSchema }) => {
    const body: Record<string, unknown> = {
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    };
    if (schema) body.response_format = { type: "json_schema", json_schema: { name: "notes", schema: jsonSchema, strict: true } };
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${process.env.OPENAI_API_KEY ?? "none"}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${base}/chat/completions returned ${res.status}: ${(await res.text()).slice(0, 500)}`);
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[]; usage?: Record<string, unknown>; model?: string };
    const content = data.choices?.[0]?.message?.content ?? "";
    const jsonText = content.slice(content.indexOf("{"), content.lastIndexOf("}") + 1);
    return { json: JSON.parse(jsonText), usage: data.usage, model: data.model };
  };
}

export function listRepoFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      if (name === "node_modules" || name === ".git" || name === ".grader") continue;
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(relative(dir, p).split("\\").join("/"));
    }
  };
  walk(dir);
  return out.sort();
}

function arg(argv: string[], name: string, fallback?: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
}

async function main(argv: string[]) {
  const here = dirname(fileURLToPath(import.meta.url));
  const task = arg(argv, "task");
  const trace = arg(argv, "trace");
  const out = arg(argv, "out");
  const provider = arg(argv, "provider", "anthropic");
  const input = (arg(argv, "input", "full") as "full" | "digest");
  if (!task || !trace || !out) {
    console.error("usage: generate.ts --task <id> --trace <trace.jsonl> --out <notes.json> [--provider anthropic|openai] [--model M] [--input full|digest] [--effort high] [--no-schema]");
    process.exit(2);
  }
  const taskDir = resolve(here, "..", "tasks", task);
  const spec = JSON.parse(readFileSync(join(taskDir, "task.json"), "utf8")) as { prompt: string; repo: string };
  const repoFiles = listRepoFiles(join(taskDir, spec.repo));
  const steps = parseTrace(readFileSync(trace, "utf8"), spec.prompt);
  const model = arg(argv, "model", provider === "anthropic" ? "claude-opus-5" : undefined);
  if (!model) throw new Error("--model is required for --provider openai");
  const call =
    provider === "anthropic"
      ? anthropicCall(model, (arg(argv, "effort", "high") as "high"))
      : openaiCompatibleCall(model, { schema: !argv.includes("--no-schema") });
  const result = await generateNotes({ steps, repoFiles, input, call, source: `gen:${provider}:${model}:${input}`, trace });
  mkdirSync(dirname(resolve(out)), { recursive: true });
  writeFileSync(out, JSON.stringify(result, null, 2) + "\n");
  console.log(`${result.notes.length} notes written to ${out}${result.dropped.length ? ` (${result.dropped.length} dropped or cut; see "dropped")` : ""}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    if (err instanceof Anthropic.APIError) console.error(`Anthropic API error ${err.status}: ${err.message}`);
    else console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
