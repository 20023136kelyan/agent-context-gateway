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
  app = createApp({ indexDir: join(root, "index"), claudeDir, codexDir, backend: "tantivy", cursorDb: join(root, "no-cursor.vscdb") });
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
    expect(body.sources.map((s: { harness: string }) => s.harness).sort()).toEqual(["claude-code", "codex", "cursor", "git", "zep"]);
  });

  it("GET /search returns provenanced results (auto-syncs empty index)", async () => {
    const server = buildHttpServer(app);
    const res = await server.inject({ method: "GET", url: "/search?q=collaboration%20workbench" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.results.length).toBeGreaterThanOrEqual(1);
    expect(body.results[0].provenance.sessionId).toBeTruthy();
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

  it("POST /sync reports indexed sessions", async () => {
    const server = buildHttpServer(app);
    const res = await server.inject({ method: "POST", url: "/sync" });
    expect(res.statusCode).toBe(200);
    expect(res.json().sessionsSeen).toBe(2);
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
