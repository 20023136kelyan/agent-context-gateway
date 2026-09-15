/**
 * Sync pipeline: adapters (truth) -> search index (disposable).
 * Backend-agnostic over SearchIndex (Tantivy primary, SQLite FTS5 fallback).
 * Incremental via file mtime/size; rebuild = clear index dir + full rescan.
 */
import { stat, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { ContextAdapter } from "../adapters/types.js";
import type { Turn } from "../core/models.js";
import type { SearchIndex } from "./types.js";
import { CursorStore } from "./store.js";

export interface SyncResult {
  sessionsSeen: number;
  sessionsIndexed: number;
  sessionsSkipped: number;
  turnsIndexed: number;
  docCount: number;
}

export async function syncAll(
  adapters: ContextAdapter[],
  index: SearchIndex,
  cursors: CursorStore,
): Promise<SyncResult> {
  let sessionsSeen = 0;
  let sessionsIndexed = 0;
  let sessionsSkipped = 0;
  let turnsIndexed = 0;

  for (const adapter of adapters) {
    const sessions = await adapter.listSessions().catch(() => []);
    sessionsSeen += sessions.length;
    for (const s of sessions) {
      let mtimeMs = 0;
      let size = 0;
      try {
        const st = await stat(s.sourcePath);
        mtimeMs = st.mtimeMs;
        size = st.size;
      } catch {
        continue; // source unavailable — skip, never fabricate
      }
      const prev = cursors.get(s.sourcePath);
      if (prev && prev.mtimeMs === mtimeMs && prev.size === size) {
        sessionsSkipped += 1;
        continue;
      }
      const turns = await adapter.listTurns(s.id).catch(() => []);
      const enriched: (Turn & { projectId: string; workspace: string; repo: string | null })[] = turns.map((t) => ({
        ...t,
        projectId: s.projectId,
        workspace: s.workspace,
        repo: s.repo ?? null,
      }));
      index.indexTurns(enriched, s.sourcePath);
      cursors.set(s.sourcePath, { mtimeMs, size });
      sessionsIndexed += 1;
      turnsIndexed += turns.length;
    }
  }
  cursors.save();
  index.markSynced();
  return { sessionsSeen, sessionsIndexed, sessionsSkipped, turnsIndexed, docCount: index.stats().docCount };
}

export async function rebuildAll(
  adapters: ContextAdapter[],
  createIndex: () => SearchIndex,
  cursors: CursorStore,
  indexDir: string,
  previous?: SearchIndex,
): Promise<{ result: SyncResult; index: SearchIndex }> {
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
    const result = await syncAll(adapters, fresh, cursors);
    return { result, index: fresh };
  } catch (e) {
    try {
      fresh.close();
    } catch {
      // ignore
    }
    throw e;
  }
}
