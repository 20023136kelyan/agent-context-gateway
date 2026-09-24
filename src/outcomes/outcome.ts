/**
 * Session outcome records: what a session set out to do, what it changed,
 * how it was checked, and how it ended, so an agent reading an earlier
 * session sees whether the fix worked and not only the discussion around it.
 *
 * Extractive, like decision extraction: every field is copied from the
 * transcript or the action index and cites its turn; nothing is generated.
 * The status is mechanical and says why:
 *
 *   verified    edits, and the last check run after the last edit passed
 *   failing     edits, and the last check run after the last edit failed
 *   unverified  edits, and no check with a known result after the last edit
 *   no-edits    the session changed no files (discussion, investigation)
 *
 * A "check" is a test, build, type-check or lint command. What the user said
 * afterwards is reported beside the status, never folded into it: "thanks"
 * after a failing test run is evidence, not proof, either way.
 *
 * A long session is several tasks (each real request and the work up to the
 * next), and each task gets the same record. A search hit is summarized by
 * the task it falls in: in a 261-edit session a single session-wide status
 * says little about the passage that was found.
 */
import type { Harness, Session, Turn } from "../core/models.js";
import type { Action } from "../actions/store.js";

export type OutcomeStatus = "verified" | "failing" | "unverified" | "no-edits";

export interface Cite {
  turnId: string;
  seq: number;
  ts: string;
  text: string;
}

export interface CheckRun {
  command: string;
  /** null: the history does not say how it ended. */
  ok: boolean | null;
  ts: string;
  turnId: string;
}

export interface SessionOutcome {
  harness: Harness;
  sessionId: string;
  project: string;
  startedAt: string;
  endedAt: string | null;
  /** The first real request: what the session set out to do. */
  problem: Cite | null;
  /** Real requests in the session, the first included. */
  requests: number;
  /** The latest later requests (corrections, pivots), oldest first. */
  followUps: Cite[];
  edits: { count: number; files: string[]; failed: number };
  /** Checks after the last edit first matter most; the last few are kept. */
  checks: CheckRun[];
  lastCheck: CheckRun | null;
  /** A successful commit after the last edit. */
  committed: boolean;
  /** A revert, restore or hard reset after the last edit. */
  reverted: boolean;
  status: OutcomeStatus;
  statusBecause: string;
  alreadyFailing: boolean;
  shellWrites: number;
  /** The user's reaction to the last task that changed files, when it has a clear tone. */
  userReported: Reaction | null;
  /** The agent's last message: usually its own account of the result. */
  finalReply: Cite | null;
  /** Each request and the work up to the next: a long session is several tasks. */
  tasks: TaskOutcome[];
}

export interface Reaction {
  tone: "problem" | "success";
  cite: Cite;
}

/** One request and the work up to the next one, judged by the same rules. */
export interface TaskOutcome {
  /** null: work before any real request (a subagent's session, say). */
  request: Cite | null;
  /** The turns it spans: seq in [fromSeq, toSeq); toSeq null = to the end. */
  fromSeq: number;
  toSeq: number | null;
  edits: { count: number; files: string[]; failed: number };
  checks: CheckRun[];
  lastCheck: CheckRun | null;
  committed: boolean;
  reverted: boolean;
  status: OutcomeStatus;
  statusBecause: string;
  /** failing, but the same check had failed before this task's first edit too. */
  alreadyFailing: boolean;
  /** Shell commands that may have written files (edits the edit tools did not see). */
  shellWrites: number;
  /** The user's next message, when short with a clear tone: their verdict on this task. */
  reaction: Reaction | null;
  /** The agent's last message in the task: usually its own account of what it did. */
  reply: Cite | null;
}

const EXCERPT = 300;
const excerpt = (text: string, max = EXCERPT) => {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
const cite = (t: Turn, text = t.content): Cite => ({ turnId: t.id, seq: t.seq, ts: t.timestamp, text: excerpt(text) });

/**
 * Text the harnesses inject as if the user typed it: environment and
 * instruction preambles, slash-command echoes, skill bodies, continuation
 * summaries, task notifications. Seen in real Claude Code and Codex histories.
 */
const INJECTED = [
  /^<environment_context>/,
  /^<user_instructions>/,
  /^<permissions/,
  /^<recommended_plugins>/,
  /^# AGENTS\.md instructions/,
  /^<INSTRUCTIONS>/,
  /^<task-notification>/,
  /^<local-command-(caveat|stdout|stderr)>/,
  /^<command-(name|message|args)>/,
  /^<system-reminder>/,
  /^\[Request interrupted by user/,
  /^Caveat: The messages below were generated/,
  /^Base directory for this skill/,
  /^This session is being continued from a previous conversation/,
  /^Continue from where you left off/i,
  /^<turn_aborted>/,
  /^<skill>/,
  // Codex's automatic approval reviewer: a whole session of it is not the user's.
  /^The following is the Codex agent history/,
];

/** A reply that moves the session along without saying anything new. */
const CHATTER = /^((continue|go on|go ahead|proceed|ok(ay)?|k|yes|yep|yeah|sure|y|no|nope|thanks?( you)?|thx|ty|yo|hi|hello|hey|next|do it|carry on|keep going|done|good|great|nice|cool|lgtm|please|pls)[\s,.!?]*)+$/i;

/**
 * What the user actually asked in a user turn, or null when the turn is
 * injected or mere chatter. Codex IDE and in-app browser turns wrap the
 * request after a list of mentioned files or the page being viewed.
 */
export function userUtterance(t: Turn): string | null {
  if (t.role !== "user") return null;
  let text = t.content.trim();
  const ide = /## My request(?: for Codex)?:\s*([\s\S]+)$/.exec(text);
  if (ide) text = ide[1]!.trim();
  else if (text.startsWith("# Files mentioned by the user") || text.startsWith("# Context from my IDE") || text.startsWith("<in-app-browser-context")) return null;
  if (INJECTED.some((rx) => rx.test(text))) return null;
  if (text.length < 8 || CHATTER.test(text)) return null;
  return text;
}

const CHECK = new RegExp(
  [
    // A tool counts only as the command being run: at the start, after a
    // separator, or behind a runner (npx, uv run, ...), never as an argument
    // ("rg pytest" searches; it does not test).
    String.raw`(^|[;&|(]\s*|\b(npx|bunx|uv run|poetry run|pipenv run|pnpm exec|yarn)\s+)(\S*/)?(pytest|jest|vitest|mocha|rspec|phpunit|tsc|mypy|pyright|ruff|flake8|eslint|golangci-lint|xcodebuild|ctest)\b`,
    String.raw`\b(npm|pnpm|yarn|bun)\s+(run\s+)?(test|tests|build|lint|typecheck|type-check|check|tsc|verify)\b`,
    String.raw`\bnpx\s+(tsc|vitest|jest|eslint|playwright\s+test)\b`,
    String.raw`\bcargo\s+(test|build|check|clippy)\b`,
    String.raw`\bgo\s+(test|build|vet)\b`,
    String.raw`\bmake\s+(test|check|build|lint)\b`,
    String.raw`\b(gradle|gradlew|mvn)\b.*\b(test|build|check|verify)\b`,
    String.raw`\b(swift|dotnet)\s+(build|test)\b`,
    String.raw`\bpython3?\s+-m\s+(pytest|unittest|mypy)\b`,
    String.raw`\bnode\s+--test\b`,
  ].join("|"),
);
export const isCheckCommand = (command: string) => CHECK.test(command);

const COMMIT = /\bgit\s+commit\b/;
const REVERT = /\bgit\s+(revert|restore\b|checkout\s+(--\s|\S+\s+--\s)|reset\s+--hard|stash(\s+push)?\s*($|[;&|]))/;

/**
 * Cues for the tone of the user's reaction. Problem wins over success in the
 * same message ("thanks, but it still fails"). Bare "works" is not a cue:
 * "study how that works" is a request, not praise.
 */
const PROBLEM_CUE = /\b(still (not|broken|fail\w*|doesn'?t|does not|isn'?t|is not|the same|getting|seeing|happening|there|an issue)|(doesn'?t|does not|didn'?t|did not|isn'?t|is not|not) work(ing|s)?|same (error|issue|problem|thing)|broke|broken|revert|roll ?back|undo|wrong|that'?s not (it|right))\b/i;
const SUCCESS_CUE = /\b((it|that|this) works|works (now|great|perfectly|fine)|working now|it worked|that worked|fixed|perfect|great|thanks|thank you|awesome|nice|lgtm|looks good|that did it|ship it|all good)\b/i;
/**
 * A reaction is short. A long message with "not working" in it is a new
 * problem being described, not a verdict on the work before it (seen in the
 * audit of real sessions).
 */
const REACTION_MAX_CHARS = 200;

function reactionTo(next: Cite | undefined): Reaction | null {
  if (!next || next.text.length > REACTION_MAX_CHARS) return null;
  if (PROBLEM_CUE.test(next.text)) return { tone: "problem", cite: next };
  if (SUCCESS_CUE.test(next.text)) return { tone: "success", cite: next };
  return null;
}

const byTime = (a: { ts: string }, b: { ts: string }) => Date.parse(a.ts) - Date.parse(b.ts);
const atOrAfter = (ts: string, since: string | null) => since === null || Date.parse(ts) >= Date.parse(since);

interface Work {
  edits: { count: number; files: string[]; failed: number };
  checks: CheckRun[];
  lastCheck: CheckRun | null;
  committed: boolean;
  reverted: boolean;
  status: OutcomeStatus;
  statusBecause: string;
  alreadyFailing: boolean;
  shellWrites: number;
}

/**
 * Shell commands that write files: `sed -i`, `perl -i`, `tee`, a redirect
 * into a file. Agents sometimes edit this way, and the edit tools never see
 * it, so "no edits" is qualified by these rather than trusted outright.
 */
const SHELL_WRITE = /\bsed\s+(-[a-zA-Z]*i|--in-place)|\bperl\s+-[a-zA-Z]*i|\btee\s|(^|[^0-9&>|])>>?\s*(?!&|\/dev\/null)[\w./~"'-]/;
const sameCheck = (a: string, b: string) => a.replace(/\s+/g, " ").trim() === b.replace(/\s+/g, " ").trim();

/**
 * The status rules, over one span of actions (a task, or the whole session).
 * `earlier` are the session's actions before the span: a check that failed
 * there too was failing before this work began.
 */
function judgeWork(acts: Action[], earlier: Action[] = []): Work {
  const edits = acts.filter((a) => a.kind === "edit" && a.ok !== false);
  const failedEdits = acts.filter((a) => a.kind === "edit" && a.ok === false).length;
  const lastEditTs = edits.length ? edits[edits.length - 1]!.ts : null;
  const commands = acts.filter((a) => a.kind === "command");
  const checks: CheckRun[] = commands
    .filter((a) => isCheckCommand(a.target))
    .map((a) => ({ command: excerpt(a.target, 200), ok: a.ok ?? null, ts: a.ts, turnId: a.turnId }));
  const after = (xs: CheckRun[]) => xs.filter((c) => atOrAfter(c.ts, lastEditTs));
  const knownAfter = after(checks).filter((c) => c.ok !== null);
  const lastCheck = knownAfter.length ? knownAfter[knownAfter.length - 1]! : checks.length ? checks[checks.length - 1]! : null;

  const afterEdit = commands.filter((a) => atOrAfter(a.ts, lastEditTs));
  const committed = lastEditTs !== null && afterEdit.some((a) => COMMIT.test(a.target) && a.ok !== false);
  const reverted = lastEditTs !== null && afterEdit.some((a) => REVERT.test(a.target) && a.ok !== false);

  const shellWrites = commands.filter((a) => SHELL_WRITE.test(a.target)).length;
  let status: OutcomeStatus;
  let statusBecause: string;
  let alreadyFailing = false;
  if (edits.length === 0) {
    status = "no-edits";
    statusBecause = failedEdits ? `no edit applied (${failedEdits} rejected)` : "no files were edited with edit tools";
    if (shellWrites) statusBecause += `; ${shellWrites} shell command${shellWrites === 1 ? "" : "s"} may have written files`;
  } else if (knownAfter.length) {
    const c = knownAfter[knownAfter.length - 1]!;
    status = c.ok ? "verified" : "failing";
    statusBecause = `the last check after the last edit ${c.ok ? "passed" : "failed"}: ${c.command}`;
    if (!c.ok) {
      // The same check's last run before this work's first edit: if it failed
      // too, the failure predates this work (a type error in a file it never
      // touched, seen across dozens of tasks in real sessions).
      const firstEditMs = Date.parse(edits[0]!.ts);
      const prior = [...earlier, ...acts]
        .filter((a) => a.kind === "command" && a.ok !== undefined && Date.parse(a.ts) < firstEditMs && sameCheck(excerpt(a.target, 200), c.command))
        .pop();
      alreadyFailing = prior?.ok === false;
      if (alreadyFailing) statusBecause += "; it was already failing before this work's first edit";
    }
  } else {
    status = "unverified";
    statusBecause = after(checks).length
      ? "checks ran after the last edit, but the history does not record how they ended"
      : "no test, build or lint ran after the last edit";
  }
  const files = [...new Set(edits.map((a) => a.target))];
  return { edits: { count: edits.length, files: files.slice(-12), failed: failedEdits }, checks: checks.slice(-5), lastCheck, committed, reverted, status, statusBecause, alreadyFailing, shellWrites };
}

/** What buildOutcome needs to know about the session itself. */
export type OutcomeSession = Pick<Session, "harness" | "id"> & Partial<Pick<Session, "projectId" | "startedAt" | "endedAt">>;

/**
 * `asOf` reads the session as it stood at that moment (point-in-time, like
 * search's asOf): later turns and actions do not exist yet.
 */
export function buildOutcome(session: OutcomeSession, allTurns: Turn[], allActions: Action[], opts: { asOf?: string } = {}): SessionOutcome {
  const cutoff = opts.asOf ? Date.parse(opts.asOf) : null;
  const upTo = <T extends { ts?: string; timestamp?: string }>(x: T) => cutoff === null || Date.parse((x.ts ?? x.timestamp)!) <= cutoff;
  const turns = allTurns.filter(upTo);
  const actions = allActions.filter(upTo);
  const ordered = [...turns].sort((a, b) => a.seq - b.seq);
  const requests: Cite[] = [];
  for (const t of ordered) {
    const said = userUtterance(t);
    if (said) requests.push(cite(t, said));
  }
  const acts = [...actions].sort(byTime);

  // Tasks: each real request and the work until the next one. Work before
  // the first request (or in a session with none, like a subagent's) is a
  // task of its own with no request.
  // One pass: actions are in time order, so each task takes the next run of
  // them (a session can hold 150 requests and thousands of actions).
  const tasks: TaskOutcome[] = [];
  const actMs = acts.map((a) => Date.parse(a.ts));
  let k = 0;
  const takeUntil = (endMs: number) => {
    const start = k;
    while (k < acts.length && actMs[k]! < endMs) k += 1;
    return acts.slice(start, k);
  };
  const before = takeUntil(requests[0] ? Date.parse(requests[0].ts) : Infinity);
  if (requests.length === 0 || before.length) {
    tasks.push({ request: null, fromSeq: 0, toSeq: requests[0]?.seq ?? null, ...judgeWork(before), reaction: reactionTo(requests[0]), reply: null });
  }
  requests.forEach((r, i) => {
    const next = requests[i + 1];
    const startIdx = k;
    const span = takeUntil(next ? Date.parse(next.ts) : Infinity);
    tasks.push({ request: r, fromSeq: r.seq, toSeq: next?.seq ?? null, ...judgeWork(span, acts.slice(0, startIdx)), reaction: reactionTo(next), reply: null });
  });
  // Each task's last agent message, in one pass (tasks and turns are both in order).
  const said = ordered.filter((t) => t.role === "assistant" && t.content.trim());
  let j = 0;
  for (const t of tasks) {
    let last: Turn | undefined;
    while (j < said.length && (t.toSeq === null || said[j]!.seq < t.toSeq)) {
      if (said[j]!.seq >= t.fromSeq) last = said[j];
      j += 1;
    }
    t.reply = last ? cite(last) : null;
  }

  const whole = judgeWork(acts);
  const lastWithEdits = [...tasks].reverse().find((t) => t.edits.count > 0);
  const lastAssistant = [...ordered].reverse().find((t) => t.role === "assistant" && t.content.trim());

  return {
    harness: session.harness,
    sessionId: session.id,
    project: session.projectId ?? "",
    startedAt: session.startedAt ?? ordered[0]?.timestamp ?? "",
    endedAt: (cutoff === null ? session.endedAt : undefined) ?? ordered[ordered.length - 1]?.timestamp ?? null,
    problem: requests[0] ?? null,
    requests: requests.length,
    followUps: requests.slice(1).slice(-3),
    ...whole,
    userReported: lastWithEdits?.reaction ?? null,
    finalReply: lastAssistant ? cite(lastAssistant) : null,
    tasks,
  };
}

/** The task a turn belongs to (by its position in the session), or the last one that changed something. */
export function taskAt(o: SessionOutcome, seq?: number): { task: TaskOutcome; index: number } | null {
  if (o.tasks.length === 0) return null;
  if (seq !== undefined) {
    const index = o.tasks.findIndex((t) => seq >= t.fromSeq && (t.toSeq === null || seq < t.toSeq));
    if (index >= 0) return { task: o.tasks[index]!, index };
  }
  let index = o.tasks.length - 1;
  while (index > 0 && o.tasks[index]!.edits.count === 0) index -= 1;
  return { task: o.tasks[index]!, index };
}

/** What a search result carries: enough to judge the hit, with the full record one call away. */
export interface OutcomeSummary {
  /** Of the task the hit belongs to: the request it answered and how that went. */
  status: OutcomeStatus;
  statusBecause: string;
  problem: string | null;
  committed: boolean;
  reverted: boolean;
  userReported: "problem" | "success" | null;
  /** failing, but it had already failed before this task's edits. */
  alreadyFailing: boolean;
  /** "3/12": which of the session's tasks, so a long session reads right. */
  task: string;
  /** Every request in the session and how it went (taskDigest), on the session's first result only. */
  digest?: string;
}

export function summarizeOutcome(o: SessionOutcome, seq?: number): OutcomeSummary {
  const at = taskAt(o, seq);
  const t = at?.task;
  return {
    status: t?.status ?? o.status,
    statusBecause: t?.statusBecause ?? o.statusBecause,
    problem: t?.request ? excerpt(t.request.text, 160) : o.problem ? excerpt(o.problem.text, 160) : null,
    committed: t?.committed ?? o.committed,
    reverted: t?.reverted ?? o.reverted,
    userReported: t?.reaction?.tone ?? null,
    alreadyFailing: t?.alreadyFailing ?? o.alreadyFailing,
    task: at ? `${at.index + 1}/${o.tasks.length}` : "0/0",
  };
}

/**
 * The session in a few lines, built around the hits: each task holding a hit
 * in full (its request, how it went, the files, and the agent's last message
 * in it), then the other requests one line each, nearest a hit first, until
 * maxChars. Copied fields only. A hit is often the request itself, and what an
 * agent needs is what was done about it; in a 70-task session a plain list cut
 * at the budget dropped the hit's task altogether.
 */
export function taskDigest(o: SessionOutcome, opts: { matchedSeqs?: number[]; maxChars?: number } = {}): string {
  const maxChars = opts.maxChars ?? 1500;
  const all = o.tasks.map((t, i) => ({ t, i })).filter(({ t }) => t.request);
  const hitIdx = new Set((opts.matchedSeqs ?? []).map((s) => taskAt(o, s)?.index).filter((i): i is number => i !== undefined));
  const head = `${o.startedAt.slice(0, 10)}, ${o.tasks.length} task(s), ${o.edits.count} edit(s), ended ${o.status}.`;
  const tag = (t: TaskOutcome, withFiles: boolean) => {
    const files = withFiles ? t.edits.files.map((f) => f.split("/").pop()).slice(-3) : [];
    return `[${t.status}${files.length ? `; ${files.join(", ")}` : ""}]`;
  };
  const hits = all.filter(({ i }) => hitIdx.has(i)).slice(0, 3);
  const full = (req: number, reply: number) =>
    new Map(
      hits.map(({ t, i }) => [
        i,
        `${i + 1}. ${excerpt(t.request!.text, req)} ${tag(t, true)} <- hit${t.reply ? `\n   agent: ${excerpt(t.reply.text, reply)}` : ""}`,
      ]),
    );
  let lines = full(220, 320);
  for (const [req, reply] of [[160, 220], [110, 150], [80, 100]] as const) {
    if ([...lines.values()].join("\n").length <= maxChars * 0.7) break;
    lines = full(req, reply);
  }
  let used = head.length + [...lines.values()].reduce((n, l) => n + l.length + 1, 0);
  // The rest, one line each: nearest a hit first (with no hit, in order).
  const dist = (i: number) => (hits.length ? Math.min(...hits.map((h) => Math.abs(h.i - i))) : i);
  const per = all.length > 30 ? 60 : 110;
  for (const { t, i } of all.filter(({ i }) => !lines.has(i)).sort((a, b) => dist(a.i) - dist(b.i) || a.i - b.i)) {
    const line = `${i + 1}. ${excerpt(t.request!.text, per)} ${tag(t, per > 60)}`;
    if (used + line.length + 1 > maxChars - 24) break;
    lines.set(i, line);
    used += line.length + 1;
  }
  const out = [head];
  let prev = -1;
  for (const { i } of all) {
    if (!lines.has(i)) continue;
    const skipped = all.filter((x) => x.i > prev && x.i < i).length;
    if (skipped) out.push(`… ${skipped} more task(s)`);
    out.push(lines.get(i)!);
    prev = i;
  }
  const after = all.filter((x) => x.i > prev).length;
  if (after) out.push(`… ${after} more task(s)`);
  const text = out.join("\n");
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`;
}

/** "verified (committed, user reported success)": the status and what backs it, in a few words. */
export function outcomeTag(o: OutcomeSummary): string {
  const extras = [o.alreadyFailing ? "already failing before" : "", o.committed ? "committed" : "", o.reverted ? "reverted" : "", o.userReported ? `user reported ${o.userReported}` : ""].filter(Boolean);
  return `${o.status}${extras.length ? ` (${extras.join(", ")})` : ""}`;
}
