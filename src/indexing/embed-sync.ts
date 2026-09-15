/**
 * Vector backfill: embed only turns missing from the store (stable IDs make
 * appends cheap). Resumable: re-running embeds just the remainder.
 * 39 embeds/s on M4 GPU -> full 100k-turn backfill ≈ 45 min; run in background.
 */
import type { ContextAdapter } from "../adapters/types.js";
import type { Session } from "../core/models.js";
import { embedTexts, embeddingsAvailable } from "../embeddings/provider.js";
import type { VectorStore } from "./vectors.js";

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

export async function embedSessionTurns(
  adapter: ContextAdapter,
  session: Session,
  vectors: VectorStore,
  batchSize = BATCH,
): Promise<{ embedded: number; skipped: number }> {
  const turns = await adapter.listTurns(session.id).catch(() => []);
  if (turns.length === 0) return { embedded: 0, skipped: 0 };
  const have = await vectors.existing(turns.map((t) => t.id)).catch(() => new Set<string>());
  const missing = turns.filter((t) => !have.has(t.id) && t.content.trim().length > 0);
  let embedded = 0;
  for (let i = 0; i < missing.length; i += batchSize) {
    const batch = missing.slice(i, i + batchSize);
    const vecs = await embedTexts(batch.map((t) => t.content));
    await vectors.upsert(
      batch.map((t, j) => ({
        id: t.id,
        vector: vecs[j],
        harness: t.harness,
        sessionId: t.sessionId,
        projectId: session.projectId,
        timestampMs: Date.parse(t.timestamp) || 0,
      })),
    );
    embedded += batch.length;
  }
  return { embedded, skipped: turns.length - missing.length };
}

export async function embedMissing(
  adapters: ContextAdapter[],
  vectors: VectorStore,
  opts?: BackfillOptions,
): Promise<EmbedResult> {
  const embStatus = await embeddingsAvailable();
  if (!embStatus.available) {
    return { sessionsScanned: 0, turnsEmbedded: 0, turnsSkipped: 0, embedded: false, reason: "embeddings-unavailable" };
  }
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
    const r = await embedSessionTurns(adapter, session, vectors, opts?.batchSize ?? BATCH);
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
  return { sessionsScanned, turnsEmbedded, turnsSkipped, embedded: true };
}
