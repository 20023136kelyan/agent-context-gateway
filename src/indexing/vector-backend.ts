/**
 * Vector backend selection.
 *
 * Mirrors how the lexical side already chooses Tantivy or SQLite behind one
 * `SearchIndex` interface: callers get a `VectorBackend` and never name a vendor.
 *
 * Default is whichever backend can actually run here. LanceDB ships no
 * darwin-x64 binary (support ended at 0.22.3), so on an Intel Mac the Lance
 * path is not merely slow, it cannot load — and because app.ts pulls this in,
 * an unguarded failure took the whole CLI down with it. Probing and falling
 * back to sqlite-vec keeps the gateway usable on every platform.
 *
 * Override with GATEWAY_VECTOR_BACKEND=lance|sqlite. A pinned backend is a hard
 * selection: it throws rather than silently writing a corpus into the other
 * backend's store, which would leave two half-populated stores and no error.
 */
import type { VectorBackend } from "./vectors.js";

export type VectorBackendName = "lance" | "sqlite";

export async function openLance(dir: string): Promise<VectorBackend> {
  const { VectorStore } = await import("./vectors.js");
  return VectorStore.open(dir);
}

export async function openSqlite(dir: string): Promise<VectorBackend> {
  const { SqliteVectorStore } = await import("./vectors-sqlite.js");
  return SqliteVectorStore.open(dir);
}

/** True when the Lance native addon exists for this platform. */
export async function lanceAvailable(): Promise<boolean> {
  try {
    const { createRequire } = await import("node:module");
    createRequire(import.meta.url)("@lancedb/lancedb");
    return true;
  } catch {
    return false;
  }
}

export async function openVectorStore(
  dir: string,
): Promise<{ store: VectorBackend; backend: VectorBackendName }> {
  const pinned = process.env.GATEWAY_VECTOR_BACKEND as VectorBackendName | undefined;
  if (pinned === "sqlite") return { store: await openSqlite(dir), backend: "sqlite" };
  if (pinned === "lance") return { store: await openLance(dir), backend: "lance" };

  if (await lanceAvailable()) {
    try {
      return { store: await openLance(dir), backend: "lance" };
    } catch {
      // fall through — a store that won't open is not a reason to have no vectors
    }
  }
  return { store: await openSqlite(dir), backend: "sqlite" };
}
