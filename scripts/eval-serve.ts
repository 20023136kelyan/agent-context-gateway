#!/usr/bin/env node
/**
 * Serve a --real eval corpus over the gateway's HTTP API, on loopback, so an
 * agent loop running elsewhere (scripts/agent-eval.ts, through an ssh tunnel)
 * searches exactly what run-eval.ts measures: the same adapters, the same
 * dead-ended harnesses, the same index and state under <root>.
 *
 * Usage: node --env-file-if-exists=.env --import tsx scripts/eval-serve.ts --real <root> [--port 8787]
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createApp, closeApp, initVectors } from "../src/app.js";
import { buildHttpServer } from "../src/transports/http.js";

const args = process.argv.slice(2);
const value = (n: string) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};
const root = value("--real");
if (!root) throw new Error("usage: eval-serve --real <root> [--port 8787]");
const port = Number(value("--port") ?? 8787);

const deadEnd = (name: string) => {
  const d = join(root, name);
  mkdirSync(d, { recursive: true });
  return d;
};
process.env.CONTEXT_GATEWAY_STATE = join(root, "state");
const app = createApp({
  claudeDir: join(root, "claude"),
  codexDir: join(root, "codex"),
  indexDir: join(root, "index"),
  cursorDb: deadEnd("empty-cursor"),
  zepDir: deadEnd("empty-zep"),
  opencodeDb: deadEnd("empty-opencode"),
  trajectoryDir: deadEnd("empty-trajectories"),
  gitRepos: [],
});
await initVectors(app).catch(() => null);
const server = buildHttpServer(app);
await server.listen({ host: "127.0.0.1", port });
console.log(`eval corpus ${root} on http://127.0.0.1:${port}`);
const stop = async () => {
  await server.close();
  closeApp(app);
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
