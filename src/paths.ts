/**
 * `acg paths`: see and change where each harness's history is read from.
 *
 * Saved in settings.json (`historyPaths`), read by adapters/locations.ts, so
 * sync, init, doctor and the watcher all follow a change. A location is
 * checked before it is saved: one where the adapter finds no sessions is
 * refused unless forced, because a wrong path otherwise looks like an empty
 * history, not like an error.
 */
import { adapterAt } from "./app.js";
import {
  detectHistories,
  historyRoots,
  isHistoryKind,
  normalizeHistoryPath,
  rootPresent,
  savedHistoryPaths,
  HISTORY_KINDS,
  type HistoryKind,
} from "./adapters/locations.js";
import { defaultStateDir, setHistoryPaths } from "./settings.js";

export interface PathRow {
  kind: HistoryKind;
  path: string;
  via: string;
  present: boolean;
  sessions: number;
}

/** Sessions the harness's adapter finds at one location (0 on any read error). */
export async function sessionsAt(kind: HistoryKind, path: string): Promise<number> {
  if (!rootPresent(kind, path)) return 0;
  return (await adapterAt(kind, path).listSessions().catch(() => [])).length;
}

export async function listPaths(env: NodeJS.ProcessEnv = process.env): Promise<PathRow[]> {
  const rows: PathRow[] = [];
  for (const h of detectHistories(env)) rows.push({ ...h, sessions: h.present ? await sessionsAt(h.kind, h.path) : 0 });
  return rows;
}

export function parseKind(kind: string): HistoryKind {
  if (!isHistoryKind(kind)) throw new Error(`unknown harness "${kind}" (one of: ${HISTORY_KINDS.join(", ")})`);
  return kind;
}

/** The gateway's own variable, when set, beats saved paths: say so rather than save silently. */
function shadowedBy(kind: HistoryKind, env: NodeJS.ProcessEnv): string | null {
  if (kind === "opencode" && env.GATEWAY_OPENCODE_DB) return "GATEWAY_OPENCODE_DB";
  if (kind === "trajectory" && env.GATEWAY_TRAJECTORY_DIR) return "GATEWAY_TRAJECTORY_DIR";
  return null;
}

export interface ChangeResult {
  kind: HistoryKind;
  paths: { path: string; sessions: number }[];
  /** Set when an environment variable overrides what was saved. */
  shadowedBy?: string;
}

/**
 * `set` replaces the harness's locations; `add` keeps the current ones (its
 * default, if that holds anything) and appends. Throws, saving nothing, if
 * any location yields no sessions and `force` is not given.
 */
export async function changePaths(
  mode: "set" | "add",
  kindArg: string,
  inputs: string[],
  opts: { force?: boolean; stateDir?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<ChangeResult> {
  const kind = parseKind(kindArg);
  const stateDir = opts.stateDir ?? defaultStateDir();
  const env = { ...(opts.env ?? process.env), CONTEXT_GATEWAY_STATE: stateDir };
  if (inputs.length === 0) throw new Error("give at least one path");
  const fresh = inputs.map((i) => normalizeHistoryPath(kind, i, env));
  const checked: { path: string; sessions: number }[] = [];
  for (const path of fresh) {
    const sessions = await sessionsAt(kind, path);
    if (sessions === 0 && !opts.force) {
      throw new Error(
        rootPresent(kind, path)
          ? `${path}: exists, but no ${kind} sessions were found in it (use --force to save it anyway)`
          : `${path}: not found (use --force to save it anyway)`,
      );
    }
    checked.push({ path, sessions });
  }
  let paths = checked.map((c) => c.path);
  if (mode === "add") {
    const current =
      savedHistoryPaths(env)[kind] ??
      historyRoots(env)
        .filter((r) => r.kind === kind && rootPresent(kind, r.path))
        .map((r) => r.path);
    paths = [...current, ...paths.filter((p) => !current.includes(p))];
  }
  setHistoryPaths(stateDir, kind, paths);
  const all: { path: string; sessions: number }[] = [];
  for (const p of paths) all.push(checked.find((c) => c.path === p) ?? { path: p, sessions: await sessionsAt(kind, p) });
  const shadow = shadowedBy(kind, env);
  return shadow ? { kind, paths: all, shadowedBy: shadow } : { kind, paths: all };
}

/** Forget one saved location, or all of them (back to the default). */
export function unsetPaths(kindArg: string, path?: string, opts: { stateDir?: string; env?: NodeJS.ProcessEnv } = {}): string[] {
  const kind = parseKind(kindArg);
  const stateDir = opts.stateDir ?? defaultStateDir();
  const env = { ...(opts.env ?? process.env), CONTEXT_GATEWAY_STATE: stateDir };
  const saved = savedHistoryPaths(env)[kind] ?? [];
  const drop = path ? normalizeHistoryPath(kind, path, env) : null;
  const keep = drop ? saved.filter((p) => p !== drop) : [];
  if (drop && keep.length === saved.length) throw new Error(`${drop} is not a saved ${kind} location`);
  setHistoryPaths(stateDir, kind, keep);
  return keep;
}
