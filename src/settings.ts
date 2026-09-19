/**
 * Central typed configuration.
 *
 * Before this, 17 environment variables were read across 34 sites, and the
 * expression `stateDir ?? CONTEXT_GATEWAY_STATE ?? $HOME/.context-gateway` was
 * copy-pasted into seven files — two of which had already drifted:
 *   - `topology/store.ts` omitted CONTEXT_GATEWAY_STATE entirely
 *   - `app.ts` resolved vectorDir from $HOME, so setting CONTEXT_GATEWAY_STATE
 *     relocated six stores but not the vectors
 * Both are fixed by routing through here.
 *
 * Resolution order: explicit options > environment > settings.json > default.
 * Environment sits ABOVE the file deliberately. Every existing user and all the
 * tests configure via env; putting a newly-introduced file above them would
 * silently change behaviour for anyone who writes one and forgets an exported
 * variable.
 *
 * GATEWAY_TOKEN is deliberately ABSENT. It is read per-request in http.ts by
 * design: the menu-bar app cannot supply it, and an operator must be able to
 * rotate it without restarting. Snapshotting it into immutable settings would
 * break both, so it stays where it is.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { VectorBackendName } from "./indexing/vector-backend.js";
import type { EmbeddingEngine } from "./embeddings/provider.js";
import type { RerankerName } from "./search/reranker.js";

export interface GatewaySettings {
  readonly version: 1;
  /** Absolute. Every derived-state store hangs off this. */
  readonly stateDir: string;
  readonly indexDir: string;
  readonly vectorDir: string;
  readonly backend: "tantivy" | "sqlite";
  /** null = probe at open time (Lance if its native addon exists, else sqlite-vec). */
  readonly vectorBackend: VectorBackendName | null;
  /** null = first available in preference order. */
  readonly embedEngine: EmbeddingEngine | null;
  /** null = first available in preference order. */
  readonly reranker: RerankerName | null;
  /** Extra Host header values accepted without a token; null = loopback only. */
  readonly allowedHosts: string[] | null;
}

/** The subset of AppOptions that settings resolve. Kept here to avoid a cycle. */
export interface SettingsOverrides {
  stateDir?: string;
  indexDir?: string;
  vectorDir?: string;
  backend?: "tantivy" | "sqlite";
}

interface SettingsFile {
  version?: number;
  stateDir?: string;
  indexDir?: string;
  vectorDir?: string;
  backend?: "tantivy" | "sqlite";
  vectorBackend?: VectorBackendName;
  embedEngine?: EmbeddingEngine;
  reranker?: RerankerName;
  allowedHosts?: string[];
}

export function defaultStateDir(): string {
  return process.env.CONTEXT_GATEWAY_STATE ?? `${process.env.HOME ?? "/tmp"}/.context-gateway`;
}

export function settingsPath(stateDir?: string): string {
  return join(stateDir ?? defaultStateDir(), "settings.json");
}

/** Missing or malformed file is not an error — settings fall back to env and defaults. */
export function loadSettingsFile(stateDir?: string): SettingsFile {
  const p = settingsPath(stateDir);
  try {
    if (!existsSync(p)) return {};
    const raw = JSON.parse(readFileSync(p, "utf8")) as SettingsFile;
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

const oneOf = <T extends string>(v: string | undefined, allowed: readonly T[]): T | null =>
  v && (allowed as readonly string[]).includes(v) ? (v as T) : null;

export function resolveSettings(opts: SettingsOverrides = {}): GatewaySettings {
  // stateDir first: the file lives inside it, so it cannot itself come from the file.
  const stateDir = opts.stateDir ?? defaultStateDir();
  const file = loadSettingsFile(stateDir);

  const backend =
    opts.backend ??
    oneOf(process.env.GATEWAY_BACKEND, ["tantivy", "sqlite"] as const) ??
    (file.backend === "sqlite" || file.backend === "tantivy" ? file.backend : null) ??
    "tantivy";

  const indexDir =
    opts.indexDir ??
    process.env.GATEWAY_INDEX_DIR ??
    file.indexDir ??
    join(stateDir, backend === "tantivy" ? "index-tantivy" : "index-sqlite");

  // The directory name stays `vectors-lance` even though sqlite-vec also lives
  // there now. Renaming it would strand every existing store, and a backfill is
  // expensive; the name is historical, not a claim about the backend.
  const vectorDir = opts.vectorDir ?? process.env.GATEWAY_VECTOR_DIR ?? file.vectorDir ?? join(stateDir, "vectors-lance");

  const allowedHostsRaw = process.env.GATEWAY_ALLOWED_HOSTS;
  const allowedHosts = allowedHostsRaw
    ? allowedHostsRaw.split(",").map((h) => h.trim()).filter(Boolean)
    : (file.allowedHosts ?? null);

  return {
    version: 1,
    stateDir,
    indexDir,
    vectorDir,
    backend,
    vectorBackend:
      oneOf(process.env.GATEWAY_VECTOR_BACKEND, ["lance", "sqlite"] as const) ?? file.vectorBackend ?? null,
    embedEngine:
      oneOf(process.env.GATEWAY_EMBED_ENGINE, ["mlx", "ollama", "voyage", "voyage-code"] as const) ??
      file.embedEngine ??
      null,
    reranker: oneOf(process.env.GATEWAY_RERANKER, ["jev", "cross-encoder", "none"] as const) ?? file.reranker ?? null,
    allowedHosts,
  };
}
