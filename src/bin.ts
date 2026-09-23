#!/usr/bin/env node
/**
 * Installed entry point (`acg`). Loads the user's `<state dir>/.env` BEFORE
 * the CLI's modules evaluate, because some read their configuration when
 * imported (a checkout gets its repo .env from gateway.sh instead).
 */
import { loadUserEnv } from "./env.js";

loadUserEnv();
await import("./cli.js");
