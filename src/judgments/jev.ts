/**
 * Jev client — TypeSafe's System One API.
 *
 * Jev returns *typed judgments with calibrated probabilities*, not prose. That
 * is the whole reason it belongs in this codebase: deterministic TypeScript
 * receives a number or an enum member and decides what to do, rather than
 * parsing generated text and hoping.
 *
 * Privacy: every call sends query text and candidate excerpts to a third party.
 * That is a deliberate departure from spec §73 Principle 5 (local-first) and
 * §25 (security boundary), and it is *worse* than the embedding case — Voyage
 * sees a one-time backfill of content you chose to index, whereas a judgment
 * call ships live query text on every request. Presence of an API key is the
 * opt-in; no call site may enable it implicitly.
 *
 * Note the local cross-encoder measures 798ms for 15 candidates on this
 * hardware against Jev's 904ms, so this is not a performance substitution. It
 * has to win on judgement quality or it should not be the default.
 */
const ENDPOINT = process.env.JEV_ENDPOINT ?? "https://api.typesafe.ai/v1/systemone";
const TIMEOUT_MS = Number(process.env.JEV_TIMEOUT_MS ?? 30_000);
const MODEL = process.env.JEV_MODEL ?? "jev-latest";

/** TYPESAFE_API_KEY is the documented name; JEV_API_KEY is accepted as an alias. */
function apiKey(): string | undefined {
  return process.env.TYPESAFE_API_KEY || process.env.JEV_API_KEY || undefined;
}

export function jevAvailable(): boolean {
  return Boolean(apiKey());
}

/** Yes/no question. The answer is the probability of "yes", in [0, 1]. */
export interface NoulQuestion {
  instructions: string;
  criteria?: { true: string; false: string };
}

/** Pick exactly one of a defined set. */
export interface ChoiceQuestion {
  instructions: string;
  options: string[];
}

/** Position on an ordered scale whose levels describe concrete situations. */
export interface ScoreQuestion {
  instructions: string;
  levels: string[];
}

export interface JevUsage {
  inputTokens?: number;
  outputTokens?: number;
}

export interface JevClient {
  /** One request, many independent yes/no judgments over shared state. */
  noul(state: unknown, questions: Record<string, NoulQuestion>): Promise<{ answers: Record<string, number>; usage?: JevUsage }>;
  choice(state: unknown, questions: Record<string, ChoiceQuestion>): Promise<{ answers: Record<string, string>; usage?: JevUsage }>;
  score(state: unknown, questions: Record<string, ScoreQuestion>): Promise<{ answers: Record<string, number>; usage?: JevUsage }>;
}

type WireQuestion =
  | { type: "noul"; instructions: string; criteria?: { true: string; false: string } }
  | { type: "choice"; instructions: string; criteria: string[] }
  | { type: "score"; instructions: string; criteria: string[] };

interface WireResponse {
  answers?: Record<string, { type?: string; noul?: number; choice?: string; score?: number }>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

async function post(state: unknown, questions: Record<string, WireQuestion>): Promise<WireResponse> {
  const key = apiKey();
  if (!key) throw new Error("jev-no-api-key");

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ state, model: MODEL, questions }),
      signal: ac.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`jev-http-${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
  }
  return (await res.json()) as WireResponse;
}

const usageOf = (w: WireResponse): JevUsage | undefined =>
  w.usage ? { inputTokens: w.usage.input_tokens, outputTokens: w.usage.output_tokens } : undefined;

export const httpJevClient: JevClient = {
  async noul(state, questions) {
    const wire: Record<string, WireQuestion> = {};
    for (const [id, q] of Object.entries(questions)) {
      wire[id] = { type: "noul", instructions: q.instructions, ...(q.criteria ? { criteria: q.criteria } : {}) };
    }
    const body = await post(state, wire);
    const answers: Record<string, number> = {};
    for (const [id, a] of Object.entries(body.answers ?? {})) {
      if (typeof a?.noul === "number") answers[id] = a.noul;
    }
    return { answers, usage: usageOf(body) };
  },

  async choice(state, questions) {
    const wire: Record<string, WireQuestion> = {};
    for (const [id, q] of Object.entries(questions)) {
      wire[id] = { type: "choice", instructions: q.instructions, criteria: q.options };
    }
    const body = await post(state, wire);
    const answers: Record<string, string> = {};
    for (const [id, a] of Object.entries(body.answers ?? {})) {
      if (typeof a?.choice === "string") answers[id] = a.choice;
    }
    return { answers, usage: usageOf(body) };
  },

  async score(state, questions) {
    const wire: Record<string, WireQuestion> = {};
    for (const [id, q] of Object.entries(questions)) {
      wire[id] = { type: "score", instructions: q.instructions, criteria: q.levels };
    }
    const body = await post(state, wire);
    const answers: Record<string, number> = {};
    for (const [id, a] of Object.entries(body.answers ?? {})) {
      if (typeof a?.score === "number") answers[id] = a.score;
    }
    return { answers, usage: usageOf(body) };
  },
};
