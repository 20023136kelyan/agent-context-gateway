/**
 * Unit & PermCov integration tests for Phase C.2 Permission-Aware Access Control (IEEE 2025).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AclStore } from "../src/security/acl.js";
import { createApp, closeApp, type GatewayApp } from "../src/app.js";
import { searchOnce, syncNow } from "../src/commands.js";
import { syncAll } from "../src/indexing/sync.js";
import { CursorStore } from "../src/indexing/store.js";
import type { Session } from "../src/core/models.js";

describe("AclStore", () => {
  let store: AclStore;

  beforeAll(async () => {
    const root = await mkdtemp(join(tmpdir(), "acg-acl-store-"));
    store = new AclStore(join(root, "acl.json"));
  });

  const mockSession = (overrides: Partial<Session> = {}): Session => ({
    id: "sess-1",
    harness: "claude-code",
    agentId: "claude:local",
    projectId: "public-project",
    workspace: "/repo/public",
    repo: "/repo/public",
    startedAt: "2026-09-10T10:00:00Z",
    sourcePath: "/path/to/sess.jsonl",
    ...overrides,
  });

  it("defaults to allowing access when no rules exist for a principal", () => {
    const sess = mockSession();
    expect(store.canAccess("unconfigured-agent", sess)).toBe(true);
    expect(store.canAccess(undefined, sess)).toBe(true);
  });

  it("restricts access to allowed projects", () => {
    store.setRule({
      principal: "restricted-agent",
      allowedProjects: ["public-project"],
    });

    expect(store.canAccess("restricted-agent", mockSession({ projectId: "public-project" }))).toBe(true);
    expect(store.canAccess("restricted-agent", mockSession({ projectId: "secret-project" }))).toBe(false);
  });

  it("restricts access to allowed harnesses and repos", () => {
    store.setRule({
      principal: "codex-only-agent",
      allowedHarnesses: ["codex"],
      allowedRepos: ["/repo/cozea"],
    });

    expect(store.canAccess("codex-only-agent", mockSession({ harness: "codex", repo: "/repo/cozea" }))).toBe(true);
    expect(store.canAccess("codex-only-agent", mockSession({ harness: "claude-code", repo: "/repo/cozea" }))).toBe(false);
    expect(store.canAccess("codex-only-agent", mockSession({ harness: "codex", repo: "/repo/other" }))).toBe(false);
  });

  it("enforces explicit denied sessions", () => {
    store.setRule({
      principal: "quarantined-agent",
      deniedSessions: ["bad-sess-99"],
    });

    expect(store.canAccess("quarantined-agent", mockSession({ id: "good-sess" }))).toBe(true);
    expect(store.canAccess("quarantined-agent", mockSession({ id: "bad-sess-99" }))).toBe(false);
  });
});

describe("search with PermCov evaluation", () => {
  let app: GatewayApp;
  let prevState: string | undefined;
  const sessionsMap = new Map<string, Session>();

  beforeAll(async () => {
    prevState = process.env.CONTEXT_GATEWAY_STATE;
    const root = await mkdtemp(join(tmpdir(), "acg-permcov-"));
    process.env.CONTEXT_GATEWAY_STATE = join(root, "state");

    const claudeDir = join(root, "claude");
    // Public Project
    await mkdir(join(claudeDir, "public-proj"), { recursive: true });
    await writeFile(
      join(claudeDir, "public-proj", "pub1.jsonl"),
      JSON.stringify({
        type: "user",
        uuid: "u1",
        timestamp: "2026-09-10T10:00:00Z",
        sessionId: "pub1",
        cwd: "/repo/public",
        message: { role: "user", content: "Lighthouse keeper audit report for open public documentation" },
      }),
    );

    // Confidential Secret Project (shares keyword "Lighthouse keeper audit")
    await mkdir(join(claudeDir, "secret-proj"), { recursive: true });
    await writeFile(
      join(claudeDir, "secret-proj", "sec1.jsonl"),
      JSON.stringify({
        type: "user",
        uuid: "u2",
        timestamp: "2026-09-10T10:00:00Z",
        sessionId: "sec1",
        cwd: "/repo/secret",
        message: { role: "user", content: "Lighthouse keeper audit report for highly confidential acquisition" },
      }),
    );

    app = createApp({
      indexDir: join(root, "index"),
      claudeDir,
      codexDir: join(root, "empty"),
      backend: "tantivy",
      cursorDb: join(root, "no.vscdb"),
    });

    await syncAll(app.adapters, app.index, new CursorStore(join(root, "index")));

    // Build session map for PermCov verification
    for (const a of app.adapters) {
      for (const s of await a.listSessions()) {
        sessionsMap.set(`${s.harness}:${s.id}`, s);
      }
    }

    // Set strict ACL rule: guest-principal can ONLY access public-proj
    app.acl.setRule({
      principal: "guest-principal",
      allowedProjects: ["public-proj"],
    });
  });

  afterAll(() => {
    closeApp(app);
    if (prevState === undefined) delete process.env.CONTEXT_GATEWAY_STATE;
    else process.env.CONTEXT_GATEWAY_STATE = prevState;
  });

  it("enforces zero permission contamination (PermCov = 0.0)", async () => {
    // Unauthenticated/open search retrieves hits from both projects
    const openRes = await searchOnce(app, "Lighthouse keeper audit report");
    const openProjects = new Set(openRes.results.map((r) => sessionsMap.get(`${r.provenance.harness}:${r.provenance.sessionId}`)?.projectId));
    expect(openProjects.has("public-proj")).toBe(true);
    expect(openProjects.has("secret-proj")).toBe(true);

    // Authenticated search as guest-principal MUST exclude secret-proj completely
    const guestRes = await searchOnce(app, "Lighthouse keeper audit report", {
      callerPrincipal: "guest-principal",
    });

    expect(guestRes.results.length).toBeGreaterThanOrEqual(1);
    for (const r of guestRes.results) {
      const s = sessionsMap.get(`${r.provenance.harness}:${r.provenance.sessionId}`);
      expect(s?.projectId).toBe("public-proj");
    }

    // Measure PermCov: fraction of unauthorized documents in results must be exactly 0.0!
    const permCov = app.acl.computePermCov(guestRes.results, "guest-principal", sessionsMap);
    expect(permCov).toBe(0.0);
  });

  it("keeps enforcing ACL after an index rebuild", async () => {
    await syncNow(app, true);
    const res = await searchOnce(app, "Lighthouse keeper audit report", { callerPrincipal: "guest-principal" });
    expect(res.results.length).toBeGreaterThanOrEqual(1);
    for (const r of res.results) {
      expect(sessionsMap.get(`${r.provenance.harness}:${r.provenance.sessionId}`)?.projectId).toBe("public-proj");
    }
  });
});
