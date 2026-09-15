/**
 * Phase 2 semantic tests — Ollama embeddings + LanceDB + hybrid ranking.
 * Skipped entirely when Ollama is down (CI without local models).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ollamaAvailable, embedTexts, EMBED_DIM } from "../src/embeddings/ollama.js";
import { VectorStore } from "../src/indexing/vectors.js";
import { createApp, closeApp, type GatewayApp } from "../src/app.js";
import { initVectors } from "../src/app.js";
import { searchOnce } from "../src/commands.js";
import { syncAll } from "../src/indexing/sync.js";
import { embedMissing } from "../src/indexing/embed-sync.js";
import { CursorStore } from "../src/indexing/store.js";

const HAS_OLLAMA = await ollamaAvailable();

const CODEX_A = "dddddddd-1111-2222-3333-444444444444"; // collab decision, no paraphrase words
const CODEX_X = "dddddddd-5555-6666-7777-888888888888"; // distractor

let app: GatewayApp;

async function setup(): Promise<GatewayApp> {
  const root = await mkdtemp(join(tmpdir(), "acg-sem-"));
  const codexDir = join(root, "codex");
  await mkdir(join(codexDir, "2026", "09", "10"), { recursive: true });
  const sess = (id: string, texts: string[]) =>
    [
      JSON.stringify({ timestamp: "2026-09-10T09:00:00Z", ordinal: 0, type: "session_meta", payload: { session_id: id, cwd: "/repo/cozea" } }),
      ...texts.map((t, i) =>
        JSON.stringify({ timestamp: `2026-09-10T09:${String(i + 1).padStart(2, "0")}:00Z`, ordinal: i + 1, type: "response_item", payload: { type: "message", id: `m${i}`, role: "assistant", content: [{ type: "output_text", text: t }] } }),
      ),
    ].join("\n");
  await writeFile(join(codexDir, "2026", "09", "10", `rollout-a-${CODEX_A}.jsonl`), sess(CODEX_A, [
    "The session workbench remains private to each participant",
    "Files are the shared primitive across sessions",
  ]));
  await writeFile(join(codexDir, "2026", "09", "10", `rollout-x-${CODEX_X}.jsonl`), sess(CODEX_X, [
    "Monaco editor should be replaced with CodeMirror",
    "The quarterly budget review is scheduled for Friday",
  ]));
  const a = createApp({ indexDir: join(root, "index"), vectorDir: join(root, "vectors"), codexDir, claudeDir: join(root, "empty-claude"), backend: "tantivy", cursorDb: join(root, "no-cursor.vscdb") });
  await syncAll(a.adapters, a.index, a.cursors);
  await initVectors(a);
  await embedMissing(a.adapters, a.vectors!);
  a.search.attachVectors(a.vectors!);
  return a;
}

describe.skipIf(!HAS_OLLAMA)("embeddings client", () => {
  it("batch embed returns Nx1024", async () => {
    const vecs = await embedTexts(["hello world", "collaboration architecture"]);
    expect(vecs).toHaveLength(2);
    expect(vecs[0]).toHaveLength(EMBED_DIM);
  });
});

describe.skipIf(!HAS_OLLAMA)("semantic search", () => {
  beforeAll(async () => {
    app = await setup();
  }, 60000);

  it("paraphrase with zero lexical overlap is rescued by vectors", async () => {
    // Fixture texts share NO content words with this query -> lexical finds nothing.
    const res = await searchOnce(app, "How should teammates jointly edit together?");
    expect(res.results.length).toBeGreaterThanOrEqual(1);
    expect(res.results[0].provenance.sessionId).toBe(CODEX_A);
  });

  it("hybrid ranks exact matches above paraphrase-level similarity", async () => {
    const res = await searchOnce(app, "session workbench private files shared primitive");
    expect(res.results[0].provenance.sessionId).toBe(CODEX_A);
  });

  it("backfill is resumable (second run embeds nothing new)", async () => {
    const again = await embedMissing(app.adapters, app.vectors!);
    expect(again.turnsEmbedded).toBe(0);
    expect(again.turnsSkipped).toBeGreaterThan(0);
  });
});
