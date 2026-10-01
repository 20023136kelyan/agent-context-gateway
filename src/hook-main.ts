#!/usr/bin/env node
/**
 * Minimal entry for agent client hooks: `node dist/hook-main.js <client> <event>`.
 * Loads only the hook code, not the CLI or the store, so each tool call pays little
 * more than Node's own start-up.
 */
import { fileURLToPath } from "node:url";
import { runHook } from "./clients/hook.js";

const [client = "", event = ""] = process.argv.slice(2);
await runHook(client, event, fileURLToPath(new URL("./cli.js", import.meta.url)));
