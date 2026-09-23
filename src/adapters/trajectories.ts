/**
 * Trajectory adapter — READ-ONLY view over SWE-Gym/OpenHands-style
 * coding-agent trajectories.
 *
 * Layout: a directory of trajectory files (env `GATEWAY_TRAJECTORY_DIR`,
 * default `<stateDir>/trajectories`). Each file is either JSON
 * (`{ instance_id, repo, steps: [{ thought, action, observation }] }`,
 * or a bare array of step objects) or JSONL (one step object per line,
 * with an optional first-line header carrying `instance_id`/`repo`).
 * Unknown extra keys are ignored; `thought`/`reasoning`, `action`/
 * `command`/`tool_call` and `observation`/`output`/`result` are accepted
 * as aliases so minor format drift still parses.
 *
 * Mapping: one file -> one Session (id = `instance_id`, projectId = repo
 * name, i.e. the part after the last `/`). Each step emits up to two
 * Turns: `thought`+`action` summary as `assistant`, `observation` as
 * `tool` (truncated to 2000 chars). Steps with neither are skipped.
 * Turn ids come from `turnId()` over `s{index}-think` / `s{index}-obs`,
 * so they are stable across reloads.
 *
 * `listSessions` reads filenames plus a small header chunk per file (no
 * full parse); every method catches file errors and yields empty results
 * rather than throwing (codex.ts precedent).
 *
 * NOTE on harness: trajectory sessions carry their own `"trajectory"`
 * harness (registered in the `Harness` union, `parseTurnId`, `adapterFor`
 * and the MCP schema), so ids, expansion and filtering all resolve to this
 * adapter instead of colliding with the `codex` slot.
 */
import { readdir, readFile, stat, open } from "node:fs/promises";
import { join, basename } from "node:path";
import type { Harness, Session, Turn, TurnRole } from "../core/models.js";
import { turnId as makeTurnId } from "../core/id.js";
import type { ContextAdapter, FileCursor } from "./types.js";
import { truncate, extractFileRefs } from "./text.js";
import { trajectoryDir } from "./locations.js";

/** Dedicated harness slot (see header note); registered across the model. */
const HARNESS: Harness = "trajectory";

const AGENT_ID = `${HARNESS}:sessions`;

/** Observation cap per spec; assistant summaries use the shared 8k cap. */
const OBS_MAX = 2000;

/** Header bytes read for the fast session scan (instance_id + repo live at the top). */
const HEADER_BYTES = 8192;

export function defaultTrajectoryDir(): string {
  return trajectoryDir();
}

type Json = Record<string, unknown>;

function asText(v: unknown): string {
  if (typeof v === "string") return v.trim();
  if (Array.isArray(v)) return v.map((x) => asText(x)).filter(Boolean).join("\n");
  if (v && typeof v === "object") {
    try {
      return JSON.stringify(v);
    } catch {
      return "";
    }
  }
  return "";
}

function firstText(o: Json, keys: string[]): string {
  for (const k of keys) {
    const t = asText(o[k]);
    if (t) return t;
  }
  return "";
}

function repoName(repo: string): string {
  const cut = repo.split("/").pop() ?? repo;
  return cut.trim() || "unknown";
}

function validDate(s: string): string | null {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

interface ParsedFile {
  instanceId: string | null;
  repo: string | null;
  steps: Json[];
}

/** Full parse of one trajectory file; null when the file is unreadable/invalid. */
function parseTrajectoryFile(raw: string, fallbackId: string, isJsonl: boolean): ParsedFile | null {
  const trimmed = raw.trim();
  if (!trimmed) return { instanceId: fallbackId, repo: null, steps: [] };
  if (isJsonl) {
    // JSONL: header fields may ride on any line (usually the first);
    // lines without step content are skipped later as empty steps.
    const steps: Json[] = [];
    let instanceId: string | null = null;
    let repo: string | null = null;
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let o: Json;
      try {
        o = JSON.parse(line) as Json;
      } catch {
        continue;
      }
      if (!o || typeof o !== "object") continue;
      if (!instanceId) instanceId = asText(o.instance_id ?? o.id) || null;
      if (!repo) repo = asText(o.repo ?? o.repo_name ?? o.repository) || null;
      steps.push(o);
    }
    return { instanceId, repo, steps };
  }
  try {
    if (trimmed.startsWith("[")) {
      const arr = JSON.parse(trimmed) as unknown;
      return {
        instanceId: fallbackId,
        repo: null,
        steps: Array.isArray(arr) ? arr.filter((s): s is Json => !!s && typeof s === "object") : [],
      };
    }
    const o = JSON.parse(trimmed) as Json;
    const stepsRaw = Array.isArray(o.steps)
      ? o.steps
      : Array.isArray(o.trajectory)
        ? o.trajectory
        : [];
    return {
      instanceId: asText(o.instance_id ?? o.id) || null,
      repo: asText(o.repo ?? o.repo_name ?? o.repository) || null,
      steps: stepsRaw.filter((s): s is Json => !!s && typeof s === "object"),
    };
  } catch {
    return null;
  }
}

export class TrajectoryAdapter implements ContextAdapter {
  readonly harness: Harness = HARNESS;
  private baseDir: string;
  private sessionCache = new Map<string, { mtimeMs: number; size: number; session: Session }>();
  private turnsCache = new Map<string, { mtimeMs: number; size: number; turns: Turn[] }>();
  /** sessionId -> file, filled by listSessions so listTurns doesn't re-scan. */
  private pathById = new Map<string, string>();

  constructor(baseDir = defaultTrajectoryDir()) {
    this.baseDir = baseDir;
  }

  capabilities() {
    return { sessions: true as const, turns: true as const, search: false as const, topology: false as const };
  }

  async listTrajectoryFiles(): Promise<string[]> {
    let entries: string[];
    try {
      entries = await readdir(this.baseDir);
    } catch {
      return [];
    }
    return entries
      .filter((f) => f.endsWith(".json") || f.endsWith(".jsonl"))
      .map((f) => join(this.baseDir, f))
      .sort();
  }

  private async readHeaderChunk(path: string): Promise<string> {
    const fh = await open(path, "r");
    try {
      const buf = Buffer.alloc(HEADER_BYTES);
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      return buf.subarray(0, bytesRead).toString("utf8");
    } finally {
      await fh.close();
    }
  }

  private headerField(chunk: string, key: string): string | null {
    const m = chunk.match(new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`));
    return m ? m[1] : null;
  }

  /** Fast session peek: header chunk only, full parse solely as fallback. */
  private async peekSession(path: string): Promise<Session | null> {
    let st: { mtimeMs: number; size: number; mtime: Date };
    try {
      const s = await stat(path);
      if (!s.isFile()) return null;
      st = s;
    } catch {
      return null;
    }
    let instanceId = basename(path).replace(/\.(jsonl|json)$/, "");
    let repo: string | null = null;
    try {
      const chunk = await this.readHeaderChunk(path);
      instanceId = this.headerField(chunk, "instance_id") ?? this.headerField(chunk, "id") ?? instanceId;
      repo = this.headerField(chunk, "repo") ?? this.headerField(chunk, "repo_name") ?? null;
      if (!this.headerField(chunk, "instance_id") && !this.headerField(chunk, "id")) {
        // Header carries no id (e.g. bare step array): pay for one full parse.
        const raw = await readFile(path, "utf8");
        const full = parseTrajectoryFile(raw, instanceId, path.endsWith(".jsonl"));
        if (!full) return null;
        instanceId = full.instanceId ?? instanceId;
        repo = full.repo ?? repo;
      }
    } catch {
      return null;
    }
    if (!instanceId) return null;
    const projectId = repo ? repoName(repo) : "unknown";
    return {
      id: instanceId,
      harness: HARNESS,
      agentId: AGENT_ID,
      projectId,
      workspace: projectId,
      repo: null,
      startedAt: st.mtime.toISOString(),
      sourcePath: path,
    };
  }

  async listSessions(): Promise<Session[]> {
    const files = await this.listTrajectoryFiles();
    const sessions: Session[] = [];
    for (const path of files) {
      try {
        const st = await stat(path);
        const cached = this.sessionCache.get(path);
        if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
          sessions.push(cached.session);
          this.pathById.set(cached.session.id, path);
          continue;
        }
        const s = await this.peekSession(path);
        if (s) {
          this.sessionCache.set(path, { mtimeMs: st.mtimeMs, size: st.size, session: s });
          sessions.push(s);
          this.pathById.set(s.id, path);
        }
      } catch {
        continue;
      }
    }
    return sessions;
  }

  async findSessionFile(sessionId: string): Promise<string | null> {
    const known = this.pathById.get(sessionId);
    if (known) {
      try {
        await stat(known);
        return known;
      } catch {
        this.pathById.delete(sessionId);
      }
    }
    const files = await this.listTrajectoryFiles();
    for (const f of files) {
      if (basename(f).replace(/\.(jsonl|json)$/, "") === sessionId) {
        this.pathById.set(sessionId, f);
        return f;
      }
    }
    for (const f of files) {
      try {
        const s = await this.peekSession(f);
        if (s && s.id === sessionId) {
          this.pathById.set(sessionId, f);
          return f;
        }
      } catch {
        continue;
      }
    }
    return null;
  }

  async listTurns(sessionId: string): Promise<Turn[]> {
    const path = await this.findSessionFile(sessionId);
    if (!path) return [];
    let st: { mtimeMs: number; size: number; mtime: Date };
    try {
      const s = await stat(path);
      if (!s.isFile()) return [];
      st = s;
    } catch {
      return [];
    }
    const cached = this.turnsCache.get(path);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
      return cached.turns;
    }
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch {
      return [];
    }
    const parsed = parseTrajectoryFile(raw, sessionId, path.endsWith(".jsonl"));
    if (!parsed) return [];
    const fallbackTs = st.mtime.toISOString();
    const turns = this.stepsToTurns(parsed.steps, sessionId, path, fallbackTs, raw);
    this.turnsCache.set(path, { mtimeMs: st.mtimeMs, size: st.size, turns });
    return turns;
  }

  private stepsToTurns(steps: Json[], sessionId: string, path: string, fallbackTs: string, raw: string): Turn[] {
    // Byte offsets for JSONL (line starts); JSON arrays share one blob — omit.
    const offsets: (number | undefined)[] = [];
    if (path.endsWith(".jsonl")) {
      let off = 0;
      for (const line of raw.split("\n")) {
        offsets.push(line.trim() ? off : undefined);
        off += Buffer.byteLength(line, "utf8") + 1;
      }
    }
    let lineIdx = 0;
    const turns: Turn[] = [];
    let seq = 0;
    for (let idx = 0; idx < steps.length; idx++) {
      const step = steps[idx];
      const head = path.endsWith(".jsonl") ? offsets[lineIdx] : undefined;
      lineIdx += 1;
      const thought = firstText(step, ["thought", "reasoning"]);
      const action = firstText(step, ["action", "command", "tool_call"]);
      const observation = firstText(step, ["observation", "output", "result", "tool_output"]);
      const ts = validDate(asText(step.timestamp)) ?? fallbackTs;
      const tool = asText(step.tool ?? step.toolName);
      const assistantParts: string[] = [];
      if (thought) assistantParts.push(thought);
      if (action) assistantParts.push(`Action: ${action}`);
      if (assistantParts.length > 0) {
        const content = truncate(assistantParts.join("\n"));
        const role: TurnRole = "assistant";
        turns.push({
          id: makeTurnId(HARNESS, sessionId, `s${idx}-think`),
          sessionId,
          harness: HARNESS,
          timestamp: ts,
          role,
          content,
          raw: { step: idx, kind: "thought-action" },
          ...(tool ? { toolNames: [tool] } : {}),
          fileRefs: extractFileRefs(content),
          seq: seq++,
          ...(head !== undefined ? { byteOffset: head } : {}),
        });
      }
      if (observation) {
        const content = truncate(observation, OBS_MAX);
        turns.push({
          id: makeTurnId(HARNESS, sessionId, `s${idx}-obs`),
          sessionId,
          harness: HARNESS,
          timestamp: ts,
          role: "tool",
          content,
          raw: { step: idx, kind: "observation" },
          ...(tool ? { toolNames: [tool] } : {}),
          fileRefs: extractFileRefs(content),
          seq: seq++,
          ...(head !== undefined ? { byteOffset: head } : {}),
        });
      }
    }
    return turns;
  }

  async getTurn(sessionId: string, turnId: string): Promise<Turn> {
    const turns = await this.listTurns(sessionId);
    const found = turns.find((t) => t.id === turnId);
    if (!found) throw new Error(`turn not found: ${turnId}`);
    return found;
  }

  async getCursor(): Promise<Record<string, FileCursor>> {
    const cursor: Record<string, FileCursor> = {};
    const files = await this.listTrajectoryFiles();
    for (const f of files) {
      try {
        const st = await stat(f);
        cursor[f] = { mtimeMs: st.mtimeMs, offsetBytes: st.size };
      } catch {
        continue;
      }
    }
    return cursor;
  }
}
