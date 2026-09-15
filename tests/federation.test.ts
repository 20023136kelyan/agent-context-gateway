/** P2e tests — token auth + read-only remote federation. */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { FastifyInstance } from "fastify";
import { createApp, closeApp, type GatewayApp } from "../src/app.js";
import { buildHttpServer, serveHttp } from "../src/transports/http.js";
import { searchOnce } from "../src/commands.js";
import { syncAll } from "../src/indexing/sync.js";
import { CursorStore } from "../src/indexing/store.js";
import { addRemote } from "../src/remotes.js";

let local: GatewayApp;
let remote: GatewayApp;
let remoteServer: FastifyInstance | null = null;
let remotePort = 0;
let prevState: string | undefined;
let prevToken: string | undefined;

const claudeLines = (id: string, text: string) =>
  JSON.stringify({ type: "user", uuid: "u1", timestamp: "2026-09-10T10:00:00Z", sessionId: id, cwd: "/repo/cozea", message: { role: "user", content: text } });

async function fixtureClaude(dir: string, id: string, text: string) {
  await mkdir(join(dir, "cozea"), { recursive: true });
  await writeFile(join(dir, "cozea", `${id}.jsonl`), claudeLines(id, text));
}

beforeAll(async () => {
  prevState = process.env.CONTEXT_GATEWAY_STATE;
  prevToken = process.env.GATEWAY_TOKEN;
  delete process.env.GATEWAY_TOKEN;
  const state = await mkdtemp(join(tmpdir(), "acg-fed-state-"));
  process.env.CONTEXT_GATEWAY_STATE = state;

  const root = await mkdtemp(join(tmpdir(), "acg-fed-"));
  const localClaude = join(root, "local-claude");
  const remoteClaude = join(root, "remote-claude");
  await fixtureClaude(localClaude, "aaaaaaaa-1111-1111-1111-111111111111", "Local folly about lighthouse keepers");
  await fixtureClaude(remoteClaude, "bbbbbbbb-2222-2222-2222-222222222222", "Remote folly about lighthouse keepers");

  local = createApp({ indexDir: join(root, "l-index"), claudeDir: localClaude, codexDir: join(root, "l-empty"), backend: "tantivy", cursorDb: join(root, "no-cursor.vscdb") });
  remote = createApp({ indexDir: join(root, "r-index"), claudeDir: remoteClaude, codexDir: join(root, "r-empty"), backend: "tantivy", cursorDb: join(root, "no-cursor.vscdb") });
  // Pre-sync so request-time ensureSynced is a cursor no-op (keeps the shared
  // event loop responsive for in-process HTTP).
  await syncAll(local.adapters, local.index, local.cursors);
  await syncAll(remote.adapters, remote.index, remote.cursors);
  remoteServer = await serveHttp(remote, 0);
  const addr = remoteServer.server.address();
  remotePort = typeof addr === "object" && addr ? addr.port : 0;
  addRemote({ name: "r2", url: `http://127.0.0.1:${remotePort}` });
});

afterAll(async () => {
  await remoteServer?.close().catch(() => {});
  closeApp(local);
  closeApp(remote);
  if (prevState === undefined) delete process.env.CONTEXT_GATEWAY_STATE;
  else process.env.CONTEXT_GATEWAY_STATE = prevState;
  if (prevToken === undefined) delete process.env.GATEWAY_TOKEN;
  else process.env.GATEWAY_TOKEN = prevToken;
});

describe("token auth", () => {
  it("health stays open; routes require bearer when configured", async () => {
    process.env.GATEWAY_TOKEN = "secret-1";
    const server = buildHttpServer(local);
    expect((await server.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    expect((await server.inject({ method: "GET", url: "/sources" })).statusCode).toBe(401);
    const authed = await server.inject({ method: "GET", url: "/sources", headers: { authorization: "Bearer secret-1" } });
    expect(authed.statusCode).toBe(200);
    delete process.env.GATEWAY_TOKEN;
  });
});

describe("federation", () => {
  it("merges remote results tagged via, with per-remote report", async () => {
    // maxResults 10: merged slice must have room for both gateways' hits.
    const res = await searchOnce(local, "lighthouse keepers folly", { maxResults: 10 });
    const vias = new Set(res.results.map((r) => r.via ?? "local"));
    expect(vias.has("local")).toBe(true);
    expect(vias.has("r2")).toBe(true);
    expect(res.federation?.remotes).toEqual([{ name: "r2", ok: true, results: expect.any(Number), error: undefined }]);
    for (const r of res.results.filter((x) => x.via === "r2")) {
      expect(r.provenance.sessionId).toBe("bbbbbbbb-2222-2222-2222-222222222222");
    }
  });

  it("dead remotes report ok:false, local results intact", async () => {
    addRemote({ name: "dead", url: "http://127.0.0.1:9" });
    const res = await searchOnce(local, "lighthouse keepers folly");
    const dead = res.federation?.remotes.find((r) => r.name === "dead");
    expect(dead?.ok).toBe(false);
    expect(dead?.error).toBeTruthy();
    expect(res.results.length).toBeGreaterThanOrEqual(1);
  });
});
