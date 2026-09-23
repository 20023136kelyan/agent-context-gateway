/**
 * Proactive context: bring an earlier agent's work to the agent that needs
 * it, before it asks.
 *
 * Runs on every prompt (Claude Code's UserPromptSubmit hook), so it must be
 * quiet by default. Retrieval proposes a few earlier sessions from the
 * caller's own project; a Jev yes/no judgment on each decides whether it
 * would actually help with this request, and only confident ones are
 * injected. Files the prompt names add exact facts from the action index
 * ("session X edited risk.py on ..."), which need no judgment. Without a Jev
 * key, search candidates are never injected: silence beats guessing.
 */
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { GatewayApp } from "./app.js";
import { searchOnce, findActions } from "./commands.js";
import { callerProject } from "./adapters/repo.js";
import { extractFileRefs } from "./adapters/text.js";
import { normalizeQuery } from "./search/query.js";
import { httpJevClient, jevAvailable, type JevClient } from "./judgments/jev.js";

export interface ProactiveInput {
  prompt: string;
  /** The agent's working directory: names its project. */
  cwd?: string;
  /** The project, when already known (evaluation); overrides cwd. */
  project?: string;
  /** The agent's own session: never offered back to itself. */
  sessionId?: string;
  /** Point-in-time (evaluation): see only history from before this. */
  asOf?: string;
}

export interface ProactiveItem {
  via: "search" | "action";
  harness: string;
  sessionId: string;
  turnId: string;
  timestamp: string;
  /** One line: what that session said, or what it did. */
  line: string;
  /** Jev's probability that it helps (search items only). */
  p?: number;
}

export interface ProactiveResult {
  /** Why nothing was injected, or "injected". */
  reason: string;
  project: string | null;
  items: ProactiveItem[];
  /** The context block to inject; empty when nothing qualifies. */
  text: string;
}

export interface ProactiveOptions {
  /** Jev client for the gate; null disables search items (no key, or tests). */
  gate?: JevClient | null;
  /** Minimum Jev probability to inject a search candidate. */
  threshold?: number;
  /** Candidate sessions the gate judges. */
  candidates?: number;
  /** Most items injected. */
  maxItems?: number;
  /** Remember what was injected per session, so nothing repeats (off in evals). */
  remember?: boolean;
}

/**
 * Calibrated 2026-09-23 on real history (scripts/eval-proactive.ts): opening
 * prompts from 98 friends' sessions, gate collected once, thresholds scored
 * offline, excerpts centred on the matching turn (excerptAround).
 *
 *            precision (strict / broad)  hit (strict / broad)  false alarms
 *   0.5      0.60 / 0.57                 57% / 44%             54%
 *   0.7      0.64 / 0.53                 43% / 26%             38%
 *   0.8      0.57 / 0.58                 21% / 19%             23-31%
 *
 * "Hit" = prompts that got at least one relevant earlier session. False alarms
 * are prompts whose project history shares no edited file; read by eye, about
 * a third of those injections were relevant anyway (e.g. a previous
 * memory-map update), so the true rate is nearer 25-30%. Within one project
 * Jev finds most sessions somewhat related: this gate is useful, not sharp.
 * 0.7 finds the right session about twice as often as 0.8 at similar
 * precision, and a false alarm costs a few lines the agent is told to ignore.
 * Small sets (14/27 positives, 13 negatives): re-run before trusting a shift.
 */
export const DEFAULT_THRESHOLD = 0.7;

const GATE = {
  instructions:
    "`request` is what a user just asked a coding agent. `candidate` is an excerpt from an earlier agent session in the same project. Would reading that earlier session help the agent handle this request?",
  criteria: {
    true: "The excerpt is about the same task, feature, file or problem, or records a decision, result or pitfall the agent should know before starting.",
    false: "The excerpt only shares general topic or wording with the request, or concerns a different task.",
  },
} as const;

/** Acknowledgements and go-aheads: a prompt made only of these asks nothing new. */
const ACK = new Set(["yes", "yeah", "yep", "no", "nope", "ok", "okay", "sure", "please", "thanks", "thank", "go", "ahead", "continue", "proceed", "it", "now", "again", "let", "lets", "let's", "great", "good", "perfect", "cool"]);

/** Not worth a lookup: slash commands, and prompts with almost no content ("ok", "yes please do"). */
export function isTrivialPrompt(prompt: string): boolean {
  const p = prompt.trim();
  if (p.startsWith("/") || p.length < 12) return true;
  return normalizeQuery(p).indexQuery.split(" ").filter((w) => w && !ACK.has(w)).length < 2;
}

function seenPath(stateDir: string, sessionId: string): string {
  return join(stateDir, "proactive", `${sessionId.replace(/[^A-Za-z0-9_-]/g, "")}.json`);
}

function loadSeen(stateDir: string, sessionId: string | undefined): Set<string> {
  if (!sessionId) return new Set();
  try {
    return new Set(JSON.parse(readFileSync(seenPath(stateDir, sessionId), "utf8")) as string[]);
  } catch {
    return new Set();
  }
}

function saveSeen(stateDir: string, sessionId: string, seen: Set<string>): void {
  const path = seenPath(stateDir, sessionId);
  mkdirSync(join(stateDir, "proactive"), { recursive: true });
  writeFileSync(path, JSON.stringify([...seen]));
}

const oneLine = (s: string, n: number) => s.replace(/\s+/g, " ").trim().slice(0, n);

const EXCERPT_CHARS = 1200;

/**
 * What the gate reads: the turn that matched first, then its neighbours,
 * nearest first. Taking the window from its start instead handed Jev the turns
 * BEFORE the match; in a long session that was all it saw, and a session that
 * did exactly the asked-about work scored p = 0.15.
 */
export function excerptAround(window: { id: string; role: string; content: string }[], centerId: string): string {
  const c = Math.max(0, window.findIndex((t) => t.id === centerId));
  const order = [c];
  for (let d = 1; order.length < window.length; d++) {
    if (c + d < window.length) order.push(c + d);
    if (c - d >= 0) order.push(c - d);
  }
  let out = "";
  for (const i of order) {
    const part = `${window[i].role}: ${window[i].content}`;
    if (out.length + part.length + 1 > EXCERPT_CHARS) {
      out += (out ? "\n" : "") + part.slice(0, Math.max(0, EXCERPT_CHARS - out.length - 1));
      break;
    }
    out += (out ? "\n" : "") + part;
  }
  return out;
}

export async function proactiveContext(
  app: GatewayApp,
  input: ProactiveInput,
  opts: ProactiveOptions = {},
): Promise<ProactiveResult> {
  const project = input.project ?? (input.cwd ? callerProject(input.cwd) : null);
  const empty = (reason: string): ProactiveResult => ({ reason, project, items: [], text: "" });
  if (isTrivialPrompt(input.prompt)) return empty("trivial prompt");

  const gate = opts.gate === undefined ? (jevAvailable() ? httpJevClient : null) : opts.gate;
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const maxItems = opts.maxItems ?? 3;
  const remember = opts.remember ?? true;
  const seen = remember ? loadSeen(app.settings.stateDir, input.sessionId) : new Set<string>();
  const fresh = (sessionId: string) => sessionId !== input.sessionId && !seen.has(sessionId);
  const items: ProactiveItem[] = [];

  // Exact facts first: earlier sessions that edited a file the prompt names.
  for (const file of extractFileRefs(input.prompt).filter((f) => !f.startsWith("PR ")).slice(0, 3)) {
    const found = await findActions(app, { file, defaultProject: project, until: input.asOf, maxSessions: 3 });
    for (const s of found.sessions) {
      if (!fresh(s.sessionId) || items.some((i) => i.sessionId === s.sessionId)) continue;
      const a = s.actions[0];
      items.push({
        via: "action", harness: s.harness, sessionId: s.sessionId, turnId: a.turnId, timestamp: a.ts,
        line: `edited ${a.target} (${s.actions.length} matching edit${s.actions.length === 1 ? "" : "s"})`,
      });
    }
  }

  // Search candidates, judged one by one. Hybrid without the reranker: the
  // gate IS the judge, and this runs before every prompt.
  if (gate) {
    const res = await searchOnce(app, input.prompt, {
      defaultProject: project, asOf: input.asOf, maxResults: 8, rerank: false,
    });
    const candidates = res.results
      .filter((r) => fresh(r.provenance.sessionId))
      .filter((r, i, all) => all.findIndex((x) => x.provenance.sessionId === r.provenance.sessionId) === i)
      .slice(0, opts.candidates ?? 5);
    const judged = await Promise.all(
      candidates.map(async (r) => {
        try {
          const excerpt = excerptAround(r.context, r.provenance.turnId);
          const { answers } = await gate.noul({ request: input.prompt.slice(0, 2000), candidate: excerpt }, { helps: GATE });
          return { r, p: typeof answers.helps === "number" ? answers.helps : null };
        } catch {
          return { r, p: null };
        }
      }),
    );
    for (const { r, p } of judged.sort((a, b) => (b.p ?? -1) - (a.p ?? -1))) {
      if (p === null || p < threshold || items.some((i) => i.sessionId === r.provenance.sessionId)) continue;
      items.push({
        via: "search", harness: r.provenance.harness, sessionId: r.provenance.sessionId, turnId: r.provenance.turnId,
        timestamp: r.provenance.timestamp, line: `"${oneLine(r.summary, 160)}"`, p,
      });
    }
  }

  const chosen = items.slice(0, maxItems);
  if (chosen.length === 0) return empty(gate ? "nothing confident enough" : "no judge configured; search items off");
  if (remember && input.sessionId) {
    for (const i of chosen) seen.add(i.sessionId);
    saveSeen(app.settings.stateDir, input.sessionId, seen);
  }
  const text = [
    "Related work from earlier agent sessions in this project (Agent Context Gateway).",
    "Open one with context.get_context(harness, sessionId, turnId) if it is useful; ignore it otherwise.",
    ...chosen.map((i) => `- ${i.harness} session ${i.sessionId.slice(0, 8)} (${i.timestamp.slice(0, 10)}) ${i.line} [turn ${i.turnId}]`),
  ].join("\n");
  return { reason: "injected", project, items: chosen, text };
}
