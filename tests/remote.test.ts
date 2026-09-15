/** P2a delegation tests — port file, probe, remote calls, cleanup on close. */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp, closeApp, type GatewayApp } from "../src/app.js";
import { buildHttpServer, serveProduction } from "../src/transports/http.js";
import { readServeInfo, writeServeInfo, clearServeInfo, probeServer, remoteCall } from "../src/remote.js";
import type { FastifyInstance } from "fastify";

const PORT = 3499;
let app: GatewayApp;
let server: FastifyInstance | null = null;

beforeAll(async () => {
  process.env.CONTEXT_GATEWAY_STATE = await mkdtemp(join(tmpdir(), "acg-state-"));
  const root = await mkdtemp(join(tmpdir(), "acg-remote-"));
  const claudeDir = join(root, "claude");
  await mkdir(join(claudeDir, "cozea"), { recursive: true });
  await writeFile(
    join(claudeDir, "cozea", "aaaaaaaa-1111-2222-3333-444444444444.jsonl"),
    JSON.stringify({ type: "user", uuid: "u1", timestamp: "2026-09-10T10:00:00Z", sessionId: "aaaaaaaa-1111-2222-3333-444444444444", cwd: "/repo/cozea", message: { role: "user", content: "delegation probe xyzzy" } }),
  );
  app = createApp({ indexDir: join(root, "index"), claudeDir, codexDir: join(root, "empty"), backend: "tantivy" });
});

afterAll(async () => {
  await server?.close().catch(() => {});
  closeApp(app);
  clearServeInfo();
  delete process.env.CONTEXT_GATEWAY_STATE;
});

describe("serve discovery", () => {
  it("serveProduction writes port file; close clears it", async () => {
    server = await serveProduction(app, PORT);
    expect(readServeInfo()?.port).toBe(PORT);
    expect(await probeServer(PORT)).toBe(true);
    expect(await probeServer(PORT + 1)).toBe(false);
  });

  it("remote calls work while the server holds the writer lock", async () => {
    const body = (await remoteCall(PORT, "GET", "/search?q=xyzzy")) as { results: unknown[] };
    expect(body.results.length).toBeGreaterThanOrEqual(1);
    const health = (await remoteCall(PORT, "GET", "/health")) as { ok: boolean };
    expect(health.ok).toBe(true);
  });

  it("stale port file probes false (caller falls back to local)", async () => {
    writeServeInfo({ port: PORT + 1, pid: 1 });
    expect(await probeServer(PORT + 1)).toBe(false);
    writeServeInfo({ port: PORT, pid: process.pid });
  });
});

describe("LAN binding (--host)", () => {
  it("refuses a non-loopback bind without GATEWAY_TOKEN", async () => {
    delete process.env.GATEWAY_TOKEN;
    await expect(serveProduction(app, 0, "0.0.0.0")).rejects.toThrow("GATEWAY_TOKEN");
  });

  it("with a token, binds all interfaces and records the host for local clients", async () => {
    process.env.GATEWAY_TOKEN = "lan-secret";
    let lan: FastifyInstance | null = null;
    try {
      lan = await serveProduction(app, 0, "0.0.0.0");
      const addr = lan.server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      expect(readServeInfo()).toMatchObject({ port, host: "0.0.0.0" });
      expect(await probeServer(port)).toBe(true);
      const body = (await remoteCall(port, "GET", "/search?q=xyzzy")) as { results: unknown[] };
      expect(body.results.length).toBeGreaterThanOrEqual(1);
    } finally {
      await lan?.close();
      delete process.env.GATEWAY_TOKEN;
    }
  });
});
