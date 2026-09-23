#!/usr/bin/env node
/**
 * Installed entry point (`acg`). Loads the user's `<state dir>/.env` BEFORE
 * the CLI's modules evaluate, because some read their configuration when
 * imported (a checkout gets its repo .env from gateway.sh instead).
 */
import { loadUserEnv } from "./env.js";

// node:sqlite still announces itself as experimental on every run. A checkout
// hides that with --disable-warning (gateway.sh); an installed bin cannot pass
// node flags portably, so drop that one warning here and keep all others.
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const text = typeof warning === "string" ? warning : warning.message;
  const type = typeof rest[0] === "string" ? rest[0] : (rest[0] as { type?: string } | undefined)?.type;
  if ((type ?? (warning as Error).name) === "ExperimentalWarning" && /SQLite/.test(text)) return;
  (emitWarning as (...a: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

loadUserEnv();
await import("./cli.js");
