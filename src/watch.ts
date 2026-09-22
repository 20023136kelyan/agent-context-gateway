/**
 * Filesystem watcher — keeps the disposable indexes seconds behind native
 * histories without manual `sync`. Watches the native roots recursively
 * (macOS FSEvents), debounces bursts (agents append rapidly), then runs the
 * normal incremental sync path (cursors make no-op runs cheap).
 */
import { watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { GatewayApp } from "./app.js";
import { syncAllDetailed } from "./indexing/sync.js";
import { notifyNewTurns } from "./commands.js";
import { embedSessionTurns, resolveEmbeddingEngine } from "./indexing/embed-sync.js";

export function defaultWatchDirs(): string[] {
  return [join(homedir(), ".claude", "projects"), join(homedir(), ".codex", "sessions")];
}

export interface WatchOptions {
  dirs?: string[];
  /** Quiet period before a sync fires (ms). Default 2000. */
  debounceMs?: number;
  /** Also embed new turns with the resolved engine (skipped gracefully when down). */
  embed?: boolean;
  onSync?: (result: { sessionsIndexed: number; turnsIndexed: number; embedded?: number }) => void;
  onError?: (err: unknown) => void;
}

export function watchSources(app: GatewayApp, opts: WatchOptions = {}): FSWatcher[] {
  const dirs = opts.dirs ?? defaultWatchDirs();
  const debounceMs = opts.debounceMs ?? 2000;
  let timer: NodeJS.Timeout | null = null;
  let syncing = false;
  let pending = false;

  const run = async () => {
    if (syncing) {
      pending = true;
      return;
    }
    syncing = true;
    try {
      // Under the app write lock: a rebuild or POST /sync can't interleave with it.
      const { result: res, indexed } = await app.indexLock.run(() =>
        syncAllDetailed(app.adapters, app.index, app.cursors, { detectNew: app.subscriptions.all().length > 0 }),
      );
      await notifyNewTurns(app, indexed.flatMap((s) => s.newTurns ?? [])).catch((e) => opts.onError?.(e));
      if (res.sessionsIndexed > 0) app.search.invalidateSessions();
      let embedded: number | undefined;
      const vectors = app.vectors;
      if (opts.embed && vectors && indexed.length > 0) {
        // Only the sessions this sync touched — never a full backfill per tick.
        embedded = await app.vectorLock
          .run(async () => {
            const engine = await resolveEmbeddingEngine();
            let n = 0;
            for (const { adapter, session } of indexed) {
              n += (await embedSessionTurns(adapter, session, vectors, undefined, engine)).embedded;
            }
            await vectors.maybeOptimize();
            return n;
          })
          .catch(() => undefined);
      }
      opts.onSync?.({ sessionsIndexed: res.sessionsIndexed, turnsIndexed: res.turnsIndexed, embedded });
    } catch (e) {
      opts.onError?.(e);
    } finally {
      syncing = false;
      if (pending) {
        pending = false;
        schedule();
      }
    }
  };

  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void run();
    }, debounceMs);
    timer.unref?.();
  };

  const watchers: FSWatcher[] = [];
  for (const dir of dirs) {
    try {
      const w = watch(dir, { recursive: true }, (event, filename) => {
        if (typeof filename === "string" && !filename.endsWith(".jsonl")) return;
        schedule();
      });
      w.on("error", (e) => opts.onError?.(e));
      watchers.push(w);
    } catch (e) {
      opts.onError?.(e);
    }
  }
  return watchers;
}
