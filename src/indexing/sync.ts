/**
 * Sync pipeline: adapters (truth) -> search index (disposable).
 * Backend-agnostic over SearchIndex (Tantivy primary, SQLite FTS5 fallback).
 * Incremental via file mtime/size; rebuild = clear index dir + full rescan.
 */
import { stat, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { ContextAdapter } from "../adapters/types.js";
import type { Session, Turn } from "../core/models.js";
import type { SearchIndex } from "./types.js";
import { CursorStore, type CursorEntry } from "./store.js";

export interface SyncResult {
  sessionsSeen: number;
  sessionsIndexed: number;
  sessionsSkipped: number;
  /** Sessions whose turns could not be read; their source is retried next sync. */
  sessionsFailed: number;
  turnsIndexed: number;
  docCount: number;
}

/** A session (re-)indexed during a sync pass. */
export interface IndexedSession {
  adapter: ContextAdapter;
  session: Session;
  turns: Turn[];
  /** Turns absent from the index before this pass (only with `detectNew`). */
  newTurns?: Turn[];
}

export interface SyncOptions {
  /** Report turns that are new to the index (costs an id lookup per session). */
  detectNew?: boolean;
}

/** Non-file sources (a Zep API URL) have no mtime/size; re-index them at most this often. */
const REMOTE_RESYNC_MS = 5 * 60 * 1000;

export function isRemoteSource(sourcePath: string): boolean {
  return /^https?:\/\//i.test(sourcePath);
}

/** Index rows carry session metadata that turns don't. */
/** Turns retrieval may return. Context-only turns (Turn.searchable) are left out. */
export function searchableTurns(turns: Turn[]): Turn[] {
  return turns.filter((t) => t.searchable !== false);
}

/** The searchable turns, with the session fields the index filters on. */
export function enrichTurns(turns: Turn[], s: Session): (Turn & { projectId: string; workspace: string; repo: string | null })[] {
  return searchableTurns(turns).map((t) => ({ ...t, projectId: s.projectId, workspace: s.workspace, repo: s.repo ?? null }));
}

export async function syncAllDetailed(
  adapters: ContextAdapter[],
  index: SearchIndex,
  cursors: CursorStore,
  opts: SyncOptions = {},
): Promise<{ result: SyncResult; indexed: IndexedSession[] }> {
  let sessionsSeen = 0;
  let sessionsIndexed = 0;
  let sessionsSkipped = 0;
  let sessionsFailed = 0;
  let turnsIndexed = 0;
  const indexed: IndexedSession[] = [];

  for (const adapter of adapters) {
    const sessions = await adapter.listSessions().catch(() => [] as Session[]);
    sessionsSeen += sessions.length;
    // One source can hold many sessions (Cursor state.vscdb, Zep threads.json,
    // Git .git): decide "changed" once per source, index all of its sessions,
    // then stamp — stamping per session would hide the rest of the source.
    const bySource = new Map<string, Session[]>();
    for (const s of sessions) {
      const group = bySource.get(s.sourcePath);
      if (group) group.push(s);
      else bySource.set(s.sourcePath, [s]);
    }
    for (const [sourcePath, group] of bySource) {
      const prev = cursors.get(sourcePath);
      let stamp: CursorEntry;
      if (isRemoteSource(sourcePath)) {
        if (prev && Date.now() - prev.mtimeMs < REMOTE_RESYNC_MS) {
          sessionsSkipped += group.length;
          continue;
        }
        stamp = { mtimeMs: Date.now(), size: -1 };
      } else {
        try {
          const st = await stat(sourcePath);
          stamp = { mtimeMs: st.mtimeMs, size: st.size };
        } catch {
          continue; // source unavailable — skip, never fabricate
        }
        if (prev && prev.mtimeMs === stamp.mtimeMs && prev.size === stamp.size) {
          sessionsSkipped += group.length;
          continue;
        }
      }
      let failed = false;
      for (const s of group) {
        let turns: Turn[];
        try {
          turns = await adapter.listTurns(s.id);
        } catch {
          sessionsFailed += 1;
          failed = true;
          continue;
        }
        const known = opts.detectNew ? index.existingIds(turns.map((t) => t.id)) : null;
        index.indexTurns(enrichTurns(turns, s), s.sourcePath, { commit: false });
        // A context-only turn is never indexed, so it would read as "new" on
        // every sync and re-notify subscribers forever: count only searchable ones.
        indexed.push({ adapter, session: s, turns, newTurns: known ? searchableTurns(turns).filter((t) => !known.has(t.id)) : undefined });
        sessionsIndexed += 1;
        turnsIndexed += turns.length;
      }
      // Leave a source with a failed session unstamped so the next sync retries it.
      if (!failed) cursors.set(sourcePath, stamp);
    }
  }
  // One commit per pass, before cursors persist: a failed commit leaves them unsaved, so the next sync retries.
  index.commit();
  cursors.save();
  index.markSynced();
  return {
    result: { sessionsSeen, sessionsIndexed, sessionsSkipped, sessionsFailed, turnsIndexed, docCount: index.docCount() },
    indexed,
  };
}

export async function syncAll(
  adapters: ContextAdapter[],
  index: SearchIndex,
  cursors: CursorStore,
): Promise<SyncResult> {
  return (await syncAllDetailed(adapters, index, cursors)).result;
}

export async function rebuildAll(
  adapters: ContextAdapter[],
  createIndex: () => SearchIndex,
  cursors: CursorStore,
  indexDir: string,
  previous?: SearchIndex,
): Promise<{ result: SyncResult; index: SearchIndex; indexed: IndexedSession[] }> {
  try {
    previous?.close();
  } catch {
    // best-effort
  }
  // Wipe disposable index files, keep cursors.json (cleared via store).
  for (const entry of await readdir(indexDir).catch(() => [] as string[])) {
    if (entry === "cursors.json") continue;
    await rm(join(indexDir, entry), { recursive: true, force: true });
  }
  cursors.clear();
  const fresh = createIndex();
  try {
    const { result, indexed } = await syncAllDetailed(adapters, fresh, cursors);
    return { result, index: fresh, indexed };
  } catch (e) {
    try {
      fresh.close();
    } catch {
      // ignore
    }
    throw e;
  }
}
