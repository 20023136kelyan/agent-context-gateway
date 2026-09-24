/** M4 transport tests — HTTP via inject, MCP via in-memory client, CLI smoke. */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp, closeApp, type GatewayApp } from "../src/app.js";
import { buildHttpServer } from "../src/transports/http.js";
import { buildMcpServer } from "../src/transports/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

let app: GatewayApp;
let root: string;
const CLAUDE_SESSION = "cccccccc-dddd-eeee-ffff-111111111111";
const CODEX_SESSION = "019fcccc-0000-1111-2222-333333333333";

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "acg-m4-"));
  const claudeDir = join(root, "claude");
  await mkdir(join(claudeDir, "cozea"), { recursive: true });
  await writeFile(
    join(claudeDir, "cozea", `${CLAUDE_SESSION}.jsonl`),
    [
      JSON.stringify({ type: "user", uuid: "u1", timestamp: "2026-09-10T10:00:00Z", sessionId: CLAUDE_SESSION, cwd: "/repo/cozea", message: { role: "user", content: "Investigate collaboration architecture" } }),
      JSON.stringify({ type: "assistant", uuid: "a1", timestamp: "2026-09-10T10:01:00Z", sessionId: CLAUDE_SESSION, cwd: "/repo/cozea", message: { role: "assistant", content: [{ type: "text", text: "Workbench private, files shared. PR #169." }] } }),
    ].join("\n"),
  );
  const codexDir = join(root, "codex");
  await mkdir(join(codexDir, "2026", "09", "10"), { recursive: true });
  await writeFile(
    join(codexDir, "2026", "09", "10", `rollout-2026-09-10T00-00-00-${CODEX_SESSION}.jsonl`),
    [
      JSON.stringify({ timestamp: "2026-09-10T09:00:00Z", ordinal: 0, type: "session_meta", payload: { session_id: CODEX_SESSION, cwd: "/repo/cozea" } }),
      JSON.stringify({ timestamp: "2026-09-10T09:01:00Z", ordinal: 1, type: "response_item", payload: { type: "message", id: "m1", role: "assistant", content: [{ type: "output_text", text: "Collaboration uses shared files." }] } }),
    ].join("\n"),
  );
  app = createApp({ indexDir: join(root, "index"), claudeDir, codexDir, backend: "tantivy", cursorDb: join(root, "no-cursor.vscdb"), opencodeDb: join(root, "no-opencode.db") });
});

afterAll(() => closeApp(app));

describe("HTTP", () => {
  it("GET /health reports backend + counts", async () => {
    const server = buildHttpServer(app);
    const res = await server.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.backend).toBe("tantivy");
    expect(body.sources.map((s: { harness: string }) => s.harness).sort()).toEqual(["claude-code", "codex", "cursor", "git", "opencode", "trajectory", "zep"]);
  });

  it("GET /search returns provenanced results (auto-syncs empty index)", async () => {
    const server = buildHttpServer(app);
    const res = await server.inject({ method: "GET", url: "/search?q=collaboration%20workbench" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.results.length).toBeGreaterThanOrEqual(1);
    expect(body.results[0].provenance.sessionId).toBeTruthy();
  });

  it("GET /search?compact=true drops the turn windows; the window route opens one", async () => {
    const server = buildHttpServer(app);
    const res = (await server.inject({ method: "GET", url: "/search?q=collaboration%20workbench&compact=true" })).json();
    expect(res.results.length).toBeGreaterThanOrEqual(1);
    expect(res.results.every((r: object) => !("context" in r))).toBe(true);
    const { harness, sessionId, turnId } = res.results[0].provenance;
    const url = `/sessions/${harness}/${sessionId}/turns/${encodeURIComponent(turnId)}?window=3&query=collaboration&maxTokens=100`;
    const turns = (await server.inject({ method: "GET", url })).json();
    expect(turns.map((t: { id: string }) => t.id)).toContain(turnId);
    expect(turns.reduce((n: number, t: { content: string }) => n + t.content.length, 0)).toBeLessThanOrEqual(400);
    // Point in time: turns written after asOf stay hidden (the hit itself is kept).
    const past = (await server.inject({ method: "GET", url: `${url}&asOf=2000-01-01T00:00:00Z` })).json();
    expect(past.map((t: { id: string }) => t.id)).toEqual([turnId]);
    const full = (await server.inject({ method: "GET", url: "/search?q=collaboration%20workbench" })).json();
    expect(full.results[0].context.length).toBeGreaterThanOrEqual(1);
  });

  it("GET /search without q is 400; unknown session is 404", async () => {
    const server = buildHttpServer(app);
    expect((await server.inject({ method: "GET", url: "/search" })).statusCode).toBe(400);
    expect((await server.inject({ method: "GET", url: "/sessions/codex/nope" })).statusCode).toBe(404);
  });

  it("session + turn direct retrieval round-trip", async () => {
    const server = buildHttpServer(app);
    const s = await server.inject({ method: "GET", url: `/sessions/claude-code/${CLAUDE_SESSION}` });
    expect(s.statusCode).toBe(200);
    const search = await server.inject({ method: "GET", url: "/search?q=workbench%20private" });
    const turnId = search.json().results[0].provenance.turnId as string;
    const [harness, sid] = [search.json().results[0].provenance.harness, search.json().results[0].provenance.sessionId];
    const t = await server.inject({ method: "GET", url: `/sessions/${harness}/${sid}/turns/${encodeURIComponent(turnId)}` });
    expect(t.statusCode).toBe(200);
    expect(t.json().id).toBe(turnId);
  });

  it("GET …/turns/:id?window=N honours N", async () => {
    const server = buildHttpServer(app);
    const search = await server.inject({ method: "GET", url: "/search?q=workbench%20private" });
    const p = search.json().results[0].provenance;
    const url = `/sessions/${p.harness}/${p.sessionId}/turns/${encodeURIComponent(p.turnId)}`;
    expect((await server.inject({ method: "GET", url: `${url}?window=0` })).json()).toHaveLength(1);
    expect((await server.inject({ method: "GET", url: `${url}?window=1` })).json().length).toBeGreaterThan(1);
  });

  it("POST /sync reports indexed sessions", async () => {
    const server = buildHttpServer(app);
    const res = await server.inject({ method: "POST", url: "/sync" });
    expect(res.statusCode).toBe(200);
    expect(res.json().sessionsSeen).toBe(2);
  });
});

describe("HTTP request origin checks", () => {
  it("rejects a foreign Host (DNS rebinding) but still answers liveness", async () => {
    const server = buildHttpServer(app);
    const res = await server.inject({ method: "GET", url: "/search?q=collaboration", headers: { host: "evil.test:3000" } });
    expect(res.statusCode).toBe(403);
    const health = await server.inject({ method: "GET", url: "/health", headers: { host: "evil.test:3000" } });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ ok: true });
  });

  it("rejects cross-site browser writes (CSRF); loopback pages and header-less clients pass", async () => {
    const server = buildHttpServer(app);
    const url = "/topology/unlink?ph=codex&ps=x&ch=codex&cs=y";
    expect((await server.inject({ method: "POST", url, headers: { origin: "https://evil.test" } })).statusCode).toBe(403);
    expect((await server.inject({ method: "POST", url, headers: { origin: "null" } })).statusCode).toBe(403);
    expect((await server.inject({ method: "POST", url, headers: { origin: "http://localhost:5173" } })).statusCode).toBe(200);
    expect((await server.inject({ method: "POST", url, headers: { host: "127.0.0.1:3000" } })).statusCode).toBe(200);
  });

  it("accepts a valid bearer token from a non-loopback Host; anonymous LAN requests are refused", async () => {
    process.env.GATEWAY_TOKEN = "tok-1";
    try {
      const server = buildHttpServer(app);
      const authed = await server.inject({ method: "GET", url: "/sources", headers: { host: "192.168.1.50:3000", authorization: "Bearer tok-1" } });
      expect(authed.statusCode).toBe(200);
      const anon = await server.inject({ method: "GET", url: "/sources", headers: { host: "192.168.1.50:3000" } });
      expect(anon.statusCode).toBe(403);
    } finally {
      delete process.env.GATEWAY_TOKEN;
    }
  });
});

describe("MCP", () => {
  it("context.search via in-memory client returns same core results", async () => {
    const server = buildMcpServer(app);
    const client = new Client({ name: "test-client", version: "0.0.0" });
    const [cTransport, sTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(sTransport), client.connect(cTransport)]);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((t) => t.name)).toContain("context.search");
      const res = await client.callTool({ name: "context.search", arguments: { query: "collaboration files" } });
      const text = (res.content as { type: string; text: string }[])[0].text;
      const body = JSON.parse(text);
      expect(body.results.length).toBeGreaterThanOrEqual(1);
      expect(body.results[0].provenance.harness).toBeTruthy();
    } finally {
      await client.close();
      await server.close();
    }
  });
});
