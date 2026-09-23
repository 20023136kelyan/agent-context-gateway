#!/usr/bin/env node
/**
 * Mine real-history eval pairs: "did an earlier agent already work on this?"
 *
 * The product question is whether an agent starting on something finds the
 * session where another agent already did it. So: for each session B, take its
 * opening request as the query, and label as relevant every EARLIER session A
 * in the same project that had already edited files B goes on to edit. The
 * query carries `asOf` = just before B started, so search sees only history
 * that existed at that moment — never B itself, never anything later.
 *
 * Labels come from this file's own parsing of the raw JSONL, not from the
 * adapters. Labels built with the system's parser would share its blind spots
 * (the Claude adapter drops tool_use inputs, so it cannot see edits at all).
 *
 * Output goes to <out>/golden-pairs.json, next to the corpus it describes.
 * It holds real opening requests, so this refuses to write inside the repo.
 *
 * Usage:
 *   npx tsx scripts/mine-pairs.ts --claude <projects dir> [--codex <sessions dir>] --out <root>
 *                                 [--min-shared 2] [--include-continuations]
 * Then: npm run eval -- --real <root> --mode lexical
 * (<root>/claude and <root>/codex must be the same dirs; symlinks are fine.)
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

type Harness = "claude-code" | "codex";

interface Edit {
  file: string;
  ts: string;
}

export interface SessionFacts {
  id: string;
  harness: Harness;
  project: string;
  start: string;
  query: string | null;
  continuation: boolean;
  edits: Edit[];
}

/** Claude Code tools that change a file, and the input field naming it. */
const CLAUDE_EDIT_TOOLS: Record<string, string> = {
  Edit: "file_path",
  MultiEdit: "file_path",
  Write: "file_path",
  NotebookEdit: "notebook_path",
};

/** apply_patch headers, as Codex writes them inside tool inputs. */
const PATCH_FILE = /\*\*\* (?:Update|Add|Delete) File: ([^\n]+)|\*\*\* Move to: ([^\n]+)/g;

/**
 * Files nearly every session touches. Sharing one says nothing about sharing
 * work, and counting them would pair every session with every other.
 */
const GENERIC = new Set([
  "package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb",
  "readme.md", "tsconfig.json", ".gitignore", ".env", ".env.example", ".env.local",
  "claude.md", "agents.md", "cargo.lock", "poetry.lock", "requirements.txt",
]);

const QUERY_CAP = 2000;

/**
 * One timestamp format for every comparison. Harnesses write different
 * precisions, and as strings "…:00Z" sorts AFTER "…:00.123Z" in the same second
 * ('.' < 'Z'), which would order a pair backwards or leak an edit past asOf.
 */
function iso(ts: unknown): string | null {
  if (typeof ts !== "string") return null;
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function argValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function* jsonLines(path: string): Generator<Record<string, any>> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return;
  }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      yield JSON.parse(line);
    } catch {
      // torn line at the end of a live file
    }
  }
}

/** First words a person typed, or null for wrappers, meta lines and tool output. */
function asRequest(text: unknown): string | null {
  if (typeof text !== "string") return null;
  const t = text.trim();
  if (t.length < 15) return null;
  // Command wrappers (<command-name>, <local-command-stdout>), injected
  // environment/instruction blocks, and the CLI caveat are not requests.
  if (t.startsWith("<") || t.startsWith("Caveat:") || t.startsWith("# AGENTS.md")) return null;
  // Codex wraps a request that comes with attachments: a "# Files mentioned
  // (or pasted) by the user:" list, then "## My request for Codex:" (or
  // "## My request:") and the actual words.
  const m = /^## My request(?: for Codex)?:[ \t]*$/m.exec(t);
  if (t.startsWith("# Files ") && m) return asRequest(t.slice(m.index + m[0].length));
  return t.slice(0, QUERY_CAP);
}

/** Repo-relative when possible, so the same file matches across sessions and harnesses. */
function normalizePath(file: string, cwd: string): string {
  const dirName = cwd ? basename(cwd) : "";
  let f = file.trim().replace(/^\.\//, "");
  if (isAbsolute(f)) {
    if (cwd && f.startsWith(cwd + "/")) f = f.slice(cwd.length + 1);
    else {
      // Another checkout of the same project (another machine, a worktree):
      // cut at the project directory name.
      const marker = `/${dirName}/`;
      const i = dirName ? f.toLowerCase().lastIndexOf(marker.toLowerCase()) : -1;
      if (i >= 0) f = f.slice(i + marker.length);
    }
  }
  return f;
}

/**
 * One key per project however its checkout folder is spelled: "Cozea 2.0" and
 * "cozea-2.0" are the same repo on two machines, and must be able to pair.
 */
function projectKey(cwd: string, fallback: string): string {
  return (cwd ? basename(cwd) : fallback).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function claudeSessions(projectsDir: string): SessionFacts[] {
  const out: SessionFacts[] = [];
  let slugs: string[] = [];
  try {
    slugs = readdirSync(projectsDir);
  } catch {
    return out;
  }
  for (const slug of slugs) {
    const dir = join(projectsDir, slug);
    let files: string[] = [];
    try {
      // Top-level files only, as the adapter lists them: subagent transcripts
      // live in subdirectories and are not sessions of their own.
      files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const file of files) {
      let cwd = "";
      let start = "";
      let query: string | null = null;
      const rawEdits: Edit[] = [];
      for (const o of jsonLines(join(dir, file))) {
        const ts = iso(o.timestamp);
        if (ts && (!start || ts < start)) start = ts;
        if (!cwd && typeof o.cwd === "string") cwd = o.cwd;
        if (o.isSidechain) continue;
        const content = o.message?.content;
        if (o.type === "user" && !o.isMeta && query === null) {
          if (typeof content === "string") query = asRequest(content);
          else if (Array.isArray(content) && !content.some((b: any) => b?.type === "tool_result")) {
            query = asRequest(content.filter((b: any) => b?.type === "text").map((b: any) => b.text).join("\n"));
          }
        }
        if (o.type === "assistant" && Array.isArray(content)) {
          for (const b of content) {
            const field = b?.type === "tool_use" ? CLAUDE_EDIT_TOOLS[b.name] : undefined;
            const path = field ? b.input?.[field] : undefined;
            if (typeof path === "string" && ts) rawEdits.push({ file: path, ts });
          }
        }
      }
      if (!start) continue;
      const project = projectKey(cwd, slug);
      out.push({
        id: file.replace(/\.jsonl$/, ""),
        harness: "claude-code",
        project,
        start,
        query,
        continuation: query?.startsWith("This session is being continued") ?? false,
        edits: rawEdits.map((e) => ({ file: normalizePath(e.file, cwd), ts: e.ts })),
      });
    }
  }
  return out;
}

function walk(dir: string, acc: string[] = []): string[] {
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return acc;
  }
  for (const e of entries) {
    const p = join(dir, e);
    try {
      if (statSync(p).isDirectory()) walk(p, acc);
      else if (e.endsWith(".jsonl")) acc.push(p);
    } catch {
      // vanished mid-walk
    }
  }
  return acc;
}

export function codexSessions(sessionsDir: string): SessionFacts[] {
  const out: SessionFacts[] = [];
  for (const path of walk(sessionsDir)) {
    let id = basename(path).replace(/\.jsonl$/, "");
    let cwd = "";
    let start = "";
    let query: string | null = null;
    const rawEdits: Edit[] = [];
    for (const o of jsonLines(path)) {
      const p = o.payload ?? {};
      const ts = iso(o.timestamp);
      if (ts && (!start || ts < start)) start = ts;
      if (o.type === "session_meta") {
        // Same precedence as the adapter, so ids match what search returns:
        // the thread's own id first (subagents share their parent's session_id).
        id = p.id ?? p.session_id ?? id;
        if (typeof p.cwd === "string") cwd = p.cwd;
        const metaTs = iso(p.timestamp);
        if (metaTs && (!start || metaTs < start)) start = metaTs;
        continue;
      }
      if (o.type !== "response_item") continue;
      if (p.type === "message" && p.role === "user" && query === null && Array.isArray(p.content)) {
        for (const b of p.content) {
          query = asRequest(b?.text);
          if (query) break;
        }
      }
      if ((p.type === "custom_tool_call" || p.type === "function_call") && ts) {
        const input = typeof p.input === "string" ? p.input : typeof p.arguments === "string" ? p.arguments : "";
        // Patches inside JSON arguments arrive with escaped newlines.
        const text = input.includes("\\n") ? input.replace(/\\n/g, "\n") : input;
        for (const m of text.matchAll(PATCH_FILE)) {
          const f = (m[1] ?? m[2] ?? "").trim();
          if (f) rawEdits.push({ file: f, ts });
        }
      }
    }
    if (!start) continue;
    const project = projectKey(cwd, "unknown");
    out.push({
      id,
      harness: "codex",
      project,
      start,
      query,
      continuation: false,
      edits: rawEdits.map((e) => ({ file: normalizePath(e.file, cwd), ts: e.ts })),
    });
  }
  return out;
}

/**
 * A file that says something about the work. Excluded: boilerplate (GENERIC),
 * the harness's own bookkeeping (.claude/ memory and launch config, edited by
 * nearly every session), and paths still absolute after normalization — those
 * lie outside the project checkout, so sharing one is not sharing repo work.
 */
const specific = (f: string) =>
  !isAbsolute(f) && !f.startsWith(".claude/") && !f.includes("/.claude/") && !GENERIC.has(basename(f).toLowerCase());

function main(): void {
  const args = process.argv.slice(2);
  const claudeDir = argValue(args, "--claude");
  const codexDir = argValue(args, "--codex");
  const outRoot = argValue(args, "--out");
  const minShared = Number(argValue(args, "--min-shared") ?? 2);
  const includeContinuations = args.includes("--include-continuations");
  if (!outRoot || (!claudeDir && !codexDir)) {
    console.error("usage: mine-pairs --claude <projects dir> [--codex <sessions dir>] --out <root> [--min-shared 2]");
    process.exit(1);
  }
  const out = resolve(outRoot);
  if (existsSync(join(process.cwd(), ".git")) && (out + "/").startsWith(resolve(process.cwd()) + "/")) {
    console.error(`refusing to write inside the repo (${out}): the output holds real opening requests`);
    process.exit(1);
  }

  const sessions = [
    ...(claudeDir ? claudeSessions(claudeDir) : []),
    ...(codexDir ? codexSessions(codexDir) : []),
  ];
  const { golden, negatives, continuationsSkipped } = minePairs(sessions, { minShared, includeContinuations });

  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "golden-pairs.json"), JSON.stringify(golden, null, 2));
  writeFileSync(join(out, "golden-negatives.json"), JSON.stringify(negatives, null, 2));
  console.error(`negatives (no earlier session shares an edited file): ${negatives.length}`);
  report(sessions, golden, continuationsSkipped, minShared, join(out, "golden-pairs.json"));
}

export interface MinedQuery {
  id: string;
  domain: "code";
  query: string;
  description: string;
  relevantSessionIds: string[];
  asOf: string;
  /** Normalised project key (same rule as src/core/project.ts). */
  project: string;
  mined: {
    querySession: string;
    queryHarness: Harness;
    project: string;
    targets: { id: string; harness: Harness; shared: number }[];
    crossHarness: boolean;
    namesSharedFile: boolean;
  };
}

/** Pair each session's opening request with the earlier sessions that did its work first. */
export function minePairs(
  all: SessionFacts[],
  opts: { minShared?: number; includeContinuations?: boolean } = {},
): { golden: MinedQuery[]; negatives: MinedQuery[]; continuationsSkipped: number } {
  const minShared = opts.minShared ?? 2;
  const sessions = [...all].sort((a, b) => a.start.localeCompare(b.start));
  const golden: MinedQuery[] = [];
  // Opening requests with earlier history in their project but no earlier
  // session sharing even one edited file: where proactive context should stay
  // quiet. File overlap is an imperfect label, so these bound false alarms
  // from above rather than measure them exactly.
  const negatives: MinedQuery[] = [];
  let continuationsSkipped = 0;
  for (const b of sessions) {
    if (!b.query) continue;
    if (b.continuation && !opts.includeContinuations) {
      continuationsSkipped += 1;
      continue;
    }
    const filesB = new Set(b.edits.map((e) => e.file).filter(specific));
    if (filesB.size === 0) continue;
    const targets: { id: string; harness: Harness; shared: string[] }[] = [];
    for (const a of sessions) {
      if (a === b || a.project !== b.project || a.start >= b.start) continue;
      // Only what A had done by the time B started is findable then.
      const filesA = new Set(a.edits.filter((e) => e.ts < b.start).map((e) => e.file).filter(specific));
      const shared = [...filesA].filter((f) => filesB.has(f));
      if (shared.length >= minShared) targets.push({ id: a.id, harness: a.harness, shared });
    }
    if (targets.length === 0) {
      const earlier = sessions.filter((a) => a !== b && a.project === b.project && a.start < b.start);
      const anyOverlap = earlier.some((a) =>
        a.edits.some((e) => e.ts < b.start && specific(e.file) && filesB.has(e.file)),
      );
      if (earlier.length > 0 && !anyOverlap) {
        negatives.push({
          id: `neg-${negatives.length + 1}`,
          domain: "code",
          query: b.query,
          description: `${b.harness} session in ${b.project}; ${earlier.length} earlier session(s), none sharing an edited file`,
          relevantSessionIds: [],
          asOf: new Date(Date.parse(b.start) - 1).toISOString(),
          project: b.project,
          mined: { querySession: b.id, queryHarness: b.harness, project: b.project, targets: [], crossHarness: false, namesSharedFile: false },
        });
      }
      continue;
    }
    targets.sort((x, y) => y.shared.length - x.shared.length);
    const allShared = [...new Set(targets.flatMap((t) => t.shared))];
    const q = b.query.toLowerCase();
    golden.push({
      id: `real-${golden.length + 1}`,
      domain: "code",
      query: b.query,
      description: `${b.harness} session in ${b.project}; ${targets.length} earlier session(s) edited files it goes on to edit`,
      relevantSessionIds: targets.map((t) => t.id),
      asOf: new Date(Date.parse(b.start) - 1).toISOString(),
      project: b.project,
      mined: {
        querySession: b.id,
        queryHarness: b.harness,
        project: b.project,
        targets: targets.map((t) => ({ id: t.id, harness: t.harness, shared: t.shared.length })),
        crossHarness: targets.some((t) => t.harness !== b.harness),
        // The query names a shared file: lexical search can match it directly.
        namesSharedFile: allShared.some((f) => q.includes(basename(f).toLowerCase())),
      },
    });
  }

  return { golden, negatives, continuationsSkipped };
}

/** Shape only: counts, never query text. */
function report(sessions: SessionFacts[], golden: MinedQuery[], continuationsSkipped: number, minShared: number, wrote: string): void {
  const by = (h: Harness) => sessions.filter((s) => s.harness === h);
  const mined = golden.map((g) => g.mined);
  const perProject: Record<string, number> = {};
  for (const m of mined) perProject[m.project] = (perProject[m.project] ?? 0) + 1;
  console.log(
    JSON.stringify(
      {
        sessions: { "claude-code": by("claude-code").length, codex: by("codex").length },
        withRequest: sessions.filter((s) => s.query).length,
        withSpecificEdits: sessions.filter((s) => s.edits.some((e) => specific(e.file))).length,
        continuationsSkipped,
        queries: golden.length,
        meanTargetsPerQuery: golden.length ? +(mined.reduce((n, m) => n + m.targets.length, 0) / golden.length).toFixed(2) : 0,
        crossHarnessQueries: mined.filter((m) => m.crossHarness).length,
        queriesNamingASharedFile: mined.filter((m) => m.namesSharedFile).length,
        queriesPerProject: perProject,
        minShared,
        wrote,
      },
      null,
      2,
    ),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
