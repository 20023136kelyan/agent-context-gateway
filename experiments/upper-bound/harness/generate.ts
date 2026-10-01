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
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { parseTrace, renderDigest, renderFull, type Step } from "./trace.js";

export const NOTE_TYPES = ["warning", "known-issue", "decision", "preference", "discovery", "how-to", "in-progress", "open-thread"] as const;

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
- conventions the user wants followed that the code cannot tell, especially where the user corrected the agent (preference)
- facts that were hard to find (discovery)
- how to do something correctly here (how-to)
Do not summarise the session, restate what the code plainly says, or give generic advice.

Each note:
- belongs to one file in the repository (use a path from the file list), and to a symbol when it is about one function or method; when it is about code that does not exist yet (a convention for new files), it belongs to the folder where that code goes, written with a trailing slash (e.g. src/exports/)
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

/**
 * Validates model output. `written` lists paths the session wrote (absolute or relative):
 * a note on one of those that is not in the repository yet is anchored to its folder.
 */
export function validateNotes(raw: unknown, repoFiles: string[], idPrefix = "gen", written: string[] = []): Pick<GeneratedNotes, "notes" | "dropped"> {
  const parsed = ModelNotes.safeParse(raw);
  if (!parsed.success) throw new Error(`model output does not match the notes schema: ${parsed.error.message}`);
  const files = new Set(repoFiles);
  const notes: GeneratedNotes["notes"] = [];
  const dropped: GeneratedNotes["dropped"] = [];
  for (const n of parsed.data.notes) {
    let path = n.path.replace(/^\.\//, "");
    const isFolder = path.endsWith("/") && repoFiles.some((f) => f.startsWith(path));
    if (!files.has(path) && !isFolder) {
      // A file the session created is not in the repository yet; its folder is.
      const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "";
      const createdHere = written.some((w) => w === path || w.endsWith(`/${path}`));
      if (createdHere && folder && repoFiles.some((f) => f.startsWith(folder))) {
        dropped.push({ reason: `new file, anchored to its folder ${folder}`, note: n });
        path = folder;
        n.symbol = null;
      } else {
        dropped.push({ reason: "path not in repository", note: n });
        continue;
      }
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
  const written = opts.steps.flatMap((s) => (s.kind === "tool_call" && ["Write", "Edit", "MultiEdit"].includes(s.tool) && typeof s.input.file_path === "string" ? [s.input.file_path] : []));
  const { notes, dropped } = validateNotes(json, opts.repoFiles, "gen", written);
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

/**
 * A model reached through OpenCode (`opencode run`), for the free models it serves.
 * The run works in an empty folder and cannot reach outside it or the web.
 */
export function opencodeCall(model: string, variant?: string): ModelCall {
  return async ({ system, user }) => {
    const dir = mkdtempSync(join(tmpdir(), "bifrost-gen-"));
    try {
      // OpenCode's free tier refuses runs with every tool denied, so tools stay on inside an empty folder.
      const deny = { webfetch: "deny", external_directory: "deny" };
      const args = ["run", "--format", "json", "--dir", dir, "--model", model];
      if (variant) args.push("--variant", variant);
      args.push(`${system}\n\n${user}\n\nAnswer with the JSON only. Do not use any tools.`);
      const r = spawnSync("opencode", args, {
        encoding: "utf8",
        maxBuffer: 1 << 28,
        timeout: 15 * 60_000,
        env: { ...process.env, OPENCODE_CONFIG_CONTENT: JSON.stringify({ share: "disabled", autoupdate: false, permission: deny }), OPENCODE_DISABLE_CLAUDE_CODE: "1" },
      });
      if (r.status !== 0) throw new Error(`opencode run failed (${r.status}): ${(r.stderr || r.error?.message || "").slice(0, 500)}`);
      let text = "";
      let usage: Record<string, unknown> | undefined;
      for (const line of r.stdout.split("\n")) {
        try {
          const e = JSON.parse(line) as { type?: string; part?: { text?: string; tokens?: Record<string, unknown> } };
          if (e.type === "text" && e.part?.text) text += e.part.text;
          if (e.type === "step_finish" && e.part?.tokens) usage = e.part.tokens;
        } catch {
          /* not an event line */
        }
      }
      const start = text.indexOf("{");
      const end = text.lastIndexOf("}");
      if (start < 0 || end < start) throw new Error(`no JSON in the model's answer: ${text.slice(0, 300)}`);
      return { json: JSON.parse(text.slice(start, end + 1)), usage, model };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
    console.error("usage: generate.ts --task <id> --trace <trace.jsonl> --out <notes.json> [--provider anthropic|openai|opencode] [--model M] [--variant V] [--input full|digest] [--effort high] [--no-schema]");
    process.exit(2);
  }
  const taskDir = resolve(here, "..", "tasks", task);
  const spec = JSON.parse(readFileSync(join(taskDir, "task.json"), "utf8")) as { prompt: string; repo: string };
  const repoFiles = listRepoFiles(join(taskDir, spec.repo));
  const steps = parseTrace(readFileSync(trace, "utf8"), spec.prompt);
  const model = arg(argv, "model", provider === "anthropic" ? "claude-opus-5" : undefined);
  if (!model) throw new Error(`--model is required for --provider ${provider}`);
  const call =
    provider === "anthropic"
      ? anthropicCall(model, (arg(argv, "effort", "high") as "high"))
      : provider === "opencode"
        ? opencodeCall(model, arg(argv, "variant"))
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
