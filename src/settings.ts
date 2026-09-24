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
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { VectorBackendName } from "./indexing/vector-backend.js";
import type { EmbeddingEngine } from "./embeddings/provider.js";
import type { RerankerName } from "./search/reranker.js";
import { ENGINE_DEFS, RERANKER_DEFS } from "./components.js";
import { RRF_K, HALF_LIFE_DAYS, RANK_WEIGHTS, SIM_FLOOR, SIM_SPAN } from "./search/rank.js";
import { EMBED_CHUNK_CHARS } from "./adapters/text.js";
import { LIVE_WINDOW_MS, LIVE_MAX_TURNS, RECENT_LIMIT } from "./collaboration/live.js";

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
  /**
   * Rerank a search that does not say. null = auto: on only when a reranker
   * was chosen (`reranker` above) or one you host is configured.
   * GATEWAY_RERANK_DEFAULT=on|off beats the file.
   */
  readonly rerankByDefault: boolean | null;
  /** Query facets (search/facets.ts). Default off; GATEWAY_FACETS=on|off beats the file. */
  readonly facets: boolean;
  /**
   * Search results without turn windows (commands.ts compactResults): the
   * agent opens the hits it needs with context.get_context. Default off;
   * GATEWAY_COMPACT=on|off beats the file.
   */
  readonly compact: boolean;
  /** Prompt -> files -> sessions (search/files.ts). Default off; GATEWAY_FILES=on|off beats the file. */
  readonly files: boolean;
  /** Extra Host header values accepted without a token; null = loopback only. */
  readonly allowedHosts: string[] | null;
  /**
   * Anonymous aggregate telemetry (report-only, never per-request rows).
   * Default OFF everywhere: env GATEWAY_TELEMETRY=on|off beats the file,
   * the file beats the default. Shipping to users with no data to improve
   * on is why this exists; shipping it silent is why it defaults off.
   */
  readonly telemetry: boolean;
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
  rerankByDefault?: boolean;
  facets?: boolean;
  compact?: boolean;
  files?: boolean;
  allowedHosts?: string[];
  telemetry?: boolean;
  /** `acg paths`: where each harness's history lives, when not the default. */
  historyPaths?: Record<string, string[]>;
}

export function defaultStateDir(): string {
  return process.env.CONTEXT_GATEWAY_STATE ?? `${process.env.HOME ?? "/tmp"}/.context-gateway`;
}

export function settingsPath(stateDir?: string): string {
  return join(stateDir ?? defaultStateDir(), "settings.json");
}

/** Persist one field of our own settings file (merge, never clobber). */
export function setTelemetry(stateDir: string | undefined, on: boolean): void {
  mkdirSync(stateDir ?? defaultStateDir(), { recursive: true });
  const file = loadSettingsFile(stateDir);
  file.telemetry = on;
  writeFileSync(settingsPath(stateDir), JSON.stringify({ ...file, version: 1 }, null, 2));
}

/** Replace one harness's saved locations (`acg paths`); null or [] removes the entry. Read by adapters/locations.ts. */
export function setHistoryPaths(stateDir: string | undefined, kind: string, paths: string[] | null): void {
  mkdirSync(stateDir ?? defaultStateDir(), { recursive: true });
  const file = loadSettingsFile(stateDir);
  const next = { ...(file.historyPaths ?? {}) };
  if (paths && paths.length) next[kind] = [...new Set(paths)];
  else delete next[kind];
  if (Object.keys(next).length) file.historyPaths = next;
  else delete file.historyPaths;
  writeFileSync(settingsPath(stateDir), JSON.stringify({ ...file, version: 1 }, null, 2));
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
      oneOf<EmbeddingEngine>(process.env.GATEWAY_EMBED_ENGINE, ENGINE_DEFS.map((e): EmbeddingEngine => e.name)) ??
      file.embedEngine ??
      null,
    reranker: oneOf<RerankerName>(process.env.GATEWAY_RERANKER, RERANKER_DEFS.map((r): RerankerName => r.name)) ?? file.reranker ?? null,
    rerankByDefault: onOff(process.env.GATEWAY_RERANK_DEFAULT) ?? file.rerankByDefault ?? null,
    facets: onOff(process.env.GATEWAY_FACETS) ?? file.facets ?? false,
    compact: onOff(process.env.GATEWAY_COMPACT) ?? file.compact ?? false,
    files: onOff(process.env.GATEWAY_FILES) ?? file.files ?? false,
    allowedHosts,
    telemetry: telemetryEnabled(file.telemetry),
  };
}

/** on/1/true/yes and off/0/false/no; anything else is unset. */
export function onOff(v: string | undefined): boolean | null {
  const t = v?.trim().toLowerCase();
  if (t === "on" || t === "1" || t === "true" || t === "yes") return true;
  if (t === "off" || t === "0" || t === "false" || t === "no") return false;
  return null;
}

/** What `acg config set` may change, and how each value is written to settings.json. */
export const SETTABLE = {
  reranker: { key: "reranker", parse: (v: string) => (RERANKER_DEFS.some((r) => r.name === v) ? v : undefined), help: RERANKER_DEFS.map((r) => r.name).join("|") },
  "rerank-default": { key: "rerankByDefault", parse: (v: string) => onOff(v) ?? undefined, help: "on|off" },
  facets: { key: "facets", parse: (v: string) => onOff(v) ?? undefined, help: "on|off" },
  compact: { key: "compact", parse: (v: string) => onOff(v) ?? undefined, help: "on|off" },
  files: { key: "files", parse: (v: string) => onOff(v) ?? undefined, help: "on|off" },
} as const;
export type SettableName = keyof typeof SETTABLE;

/** Set (or with null, remove) one `acg config set` field in settings.json, merging. */
export function setSetting(stateDir: string | undefined, name: SettableName, raw: string | null): void {
  const def = SETTABLE[name];
  const value = raw === null ? undefined : def.parse(raw);
  if (raw !== null && value === undefined) throw new Error(`bad value "${raw}" for ${name} (want ${def.help})`);
  mkdirSync(stateDir ?? defaultStateDir(), { recursive: true });
  const file = loadSettingsFile(stateDir) as Record<string, unknown>;
  if (value === undefined) delete file[def.key];
  else file[def.key] = value;
  writeFileSync(settingsPath(stateDir), JSON.stringify({ ...file, version: 1 }, null, 2));
}

/** Explicit opt-in only: unset/anything-else = off. */
function telemetryEnabled(fileValue: boolean | undefined): boolean {
  const env = process.env.GATEWAY_TELEMETRY?.trim().toLowerCase();
  if (env === "on" || env === "1" || env === "true") return true;
  if (env === "off" || env === "0" || env === "false") return false;
  return fileValue === true;
}

/** Effective tunable values for sweepability: every GATEWAY_* knob in one place.
 *
 * Sources of truth stay in their modules (rank.ts, text.ts, live.ts,
 * search.ts); this snapshots them alongside resolveSettings() so `gateway
 * config` prints what a sweep actually ran with. Plain JSON-serializable.
 */
export function dumpConfig(): Record<string, unknown> {
  const s = resolveSettings();
  // Mirrors src/search/search.ts (kept local so settings stays free of the
  // search dependency chain): same defaults, same validation.
  const minVectorSim = (() => {
    const raw = Number(process.env.GATEWAY_MIN_VECTOR_SIM ?? 0.25);
    return Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : 0.25;
  })();
  const rerankPool = (() => {
    const raw = Number(process.env.GATEWAY_RERANK_POOL ?? 30);
    return Number.isFinite(raw) && raw >= 1 && raw <= 100 ? Math.floor(raw) : 30;
  })();
  // Mirrors src/decisions/select.ts: a pin never falls back; null = auto.
  const judgeRaw = process.env.GATEWAY_JUDGE;
  const judge = judgeRaw === "jev" || judgeRaw === "heuristic" ? judgeRaw : null;
  return {
    stateDir: s.stateDir,
    indexDir: s.indexDir,
    vectorDir: s.vectorDir,
    backend: s.backend,
    vectorBackend: s.vectorBackend,
    embedEngine: s.embedEngine,
    reranker: s.reranker,
    rerankByDefault: s.rerankByDefault,
    facets: s.facets,
    compact: s.compact,
    files: s.files,
    judge,
    allowedHosts: s.allowedHosts,
    minVectorSim,
    rerankPool,
    tokenizer: process.env.GATEWAY_TOKENIZER === "en_stem" ? "en_stem" : "default",
    simFloor: SIM_FLOOR,
    simSpan: SIM_SPAN,
    rrfK: RRF_K,
    halfLifeDays: HALF_LIFE_DAYS,
    weights: { ...RANK_WEIGHTS },
    chunkChars: EMBED_CHUNK_CHARS,
    liveWindowMs: LIVE_WINDOW_MS,
    liveTurns: LIVE_MAX_TURNS,
    subRecent: RECENT_LIMIT,
  };
}
