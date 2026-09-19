/**
 * Vector backfill: embed only the windows missing from the store (stable IDs
 * make appends cheap). Resumable: re-running embeds just the remainder.
 *
 * The unit is an embedding window, not a turn — a turn longer than BGE's
 * context becomes several rows (see `chunkForEmbedding`), so a corpus yields
 * more rows than turns and a backfill costs correspondingly more than the
 * 39 turns/s an M4 GPU managed when each turn was one embed. Run in background.
 */
import type { ContextAdapter } from "../adapters/types.js";
import type { Session, Turn } from "../core/models.js";
import { chunkForEmbedding } from "../adapters/text.js";
import { embedChunkId } from "../core/id.js";
import { embedTextsWith, embeddingsAvailable, type EmbeddingEngine } from "../embeddings/provider.js";
import type { VectorBackend } from "./vectors.js";

export interface EmbedResult {
  sessionsScanned: number;
  turnsEmbedded: number;
  turnsSkipped: number;
  embedded: boolean;
  reason?: string;
}

export interface BackfillOptions {
  batchSize?: number;
  maxSessions?: number;
  onProgress?: (p: {
    sessionsScanned: number;
    totalSessions: number;
    turnsEmbedded: number;
    turnsSkipped: number;
    currentSessionId?: string;
  }) => void;
}

const BATCH = 64;
/** Rows buffered per vector-store write: each LanceDB write adds a fragment + version. */
const WRITE_BATCH = 512;

export async function resolveEmbeddingEngine(): Promise<EmbeddingEngine> {
  const status = await embeddingsAvailable();
  if (status.engine === "none") throw new Error("embeddings-unavailable");
  return status.engine;
}

export async function embedSessionTurns(
  adapter: ContextAdapter,
  session: Session,
  vectors: VectorBackend,
  batchSize = BATCH,
  engine?: EmbeddingEngine,
): Promise<{ embedded: number; skipped: number }> {
  const turns = await adapter.listTurns(session.id).catch(() => []);
  if (turns.length === 0) return { embedded: 0, skipped: 0 };
  // One engine per call: dedup must check the table that engine writes to.
  const eng = engine ?? (await resolveEmbeddingEngine());

  // One row per embedding window, not per turn: whole-turn embedding fed the
  // model only the first ~512 tokens. Empty turns chunk to nothing and drop out
  // here, which is the old `content.trim()` filter.
  const planned: { id: string; text: string; turn: Turn }[] = [];
  for (const t of turns) {
    chunkForEmbedding(t.content).forEach((text, i) => planned.push({ id: embedChunkId(t.id, i), text, turn: t }));
  }
  // Asking per window rather than per turn is what upgrades an existing corpus:
  // a long turn embedded before chunking has window 0 and gains only its tail.
  const have = await vectors.existing(planned.map((p) => p.id), eng).catch(() => new Set<string>());
  const missing = planned.filter((p) => !have.has(p.id));

  const touched = new Set<string>();
  let pending: Parameters<VectorBackend["upsert"]>[0] = [];
  for (let i = 0; i < missing.length; i += batchSize) {
    const batch = missing.slice(i, i + batchSize);
    const vecs = await embedTextsWith(eng, batch.map((p) => p.text));
    pending.push(
      ...batch.map((p, j) => ({
        id: p.id,
        vector: vecs[j],
        harness: p.turn.harness,
        sessionId: p.turn.sessionId,
        projectId: session.projectId,
        timestampMs: Date.parse(p.turn.timestamp) || 0,
      })),
    );
    for (const p of batch) touched.add(p.turn.id);
    if (pending.length >= WRITE_BATCH) {
      await vectors.upsert(pending, eng);
      pending = [];
    }
  }
  if (pending.length > 0) await vectors.upsert(pending, eng);
  // Counted in turns, not windows, so these stay comparable across the change.
  return { embedded: touched.size, skipped: turns.length - touched.size };
}

export async function embedMissing(
  adapters: ContextAdapter[],
  vectors: VectorBackend,
  opts?: BackfillOptions,
): Promise<EmbedResult> {
  const embStatus = await embeddingsAvailable();
  if (embStatus.engine === "none") {
    return { sessionsScanned: 0, turnsEmbedded: 0, turnsSkipped: 0, embedded: false, reason: "embeddings-unavailable" };
  }
  // Pinned for the whole run so a mid-run fallback can't scatter one corpus
  // across two engines' tables.
  const engine = embStatus.engine;
  let sessionsScanned = 0;
  let turnsEmbedded = 0;
  let turnsSkipped = 0;

  const allSessions: { adapter: ContextAdapter; session: Session }[] = [];
  for (const adapter of adapters) {
    const ss = await adapter.listSessions().catch(() => []);
    for (const s of ss) allSessions.push({ adapter, session: s });
  }

  const targetSessions = opts?.maxSessions ? allSessions.slice(0, opts.maxSessions) : allSessions;

  for (const { adapter, session } of targetSessions) {
    sessionsScanned += 1;
    const r = await embedSessionTurns(adapter, session, vectors, opts?.batchSize ?? BATCH, engine);
    turnsEmbedded += r.embedded;
    turnsSkipped += r.skipped;
    opts?.onProgress?.({
      sessionsScanned,
      totalSessions: targetSessions.length,
      turnsEmbedded,
      turnsSkipped,
      currentSessionId: session.id,
    });
  }
  // Compact the fragments the run wrote and index ids for future dedup lookups.
  if (turnsEmbedded > 0) await vectors.optimize();
  return { sessionsScanned, turnsEmbedded, turnsSkipped, embedded: true };
}
