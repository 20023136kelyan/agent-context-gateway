/**
 * Fastify HTTP transport — loopback only (local-only MVP, no remote).
 * Export buildHttpServer for tests (inject); serveHttp binds 127.0.0.1.
 */
import Fastify, { type FastifyInstance } from "fastify";
import type { GatewayApp } from "../app.js";
import type { Harness } from "../core/models.js";
import { listSources, listSessions, searchOnce, decideOnce, getRelated, traverseArtifacts, listInvalidations, recordInvalidation, listAclRules, setAclRule, removeAclRule, searchLive, getLineage, listSubscriptions, createSubscription, cancelSubscription, recordFeedback, getSession, getTurn, getContext, syncNow, syncSession, backfillEmbeddings, linkSessions, unlinkSessions, showTopology, health } from "../commands.js";
import { writeServeInfo, clearServeInfo } from "../remote.js";
import { handleGitCommitEvent, type GitCommitEvent } from "../git/hooks.js";

function toStatus(e: unknown): { code: number; message: string } {
  const msg = e instanceof Error ? e.message : String(e);
  if (msg.startsWith("not_found")) return { code: 404, message: msg };
  if (msg.startsWith("bad_request") || msg.startsWith("not_supported")) return { code: 400, message: msg };
  return { code: 500, message: msg };
}

export function buildHttpServer(app: GatewayApp): FastifyInstance {
  const fastify = Fastify({ logger: false });

  // P2e token auth: when GATEWAY_TOKEN is set, every route except liveness
  // needs `Authorization: Bearer <token>`. MCP/CLI-local paths are unaffected
  // (same-user IPC); loopback HTTP is the trust boundary for remotes.
  fastify.addHook("onRequest", async (req, reply) => {
    if (req.url === "/health" || req.url.startsWith("/health?")) return;
    const want = process.env.GATEWAY_TOKEN;
    if (!want) return;
    const got = req.headers.authorization;
    if (got !== `Bearer ${want}`) {
      return reply.code(401).send({ error: "unauthorized: bad or missing bearer token" });
    }
  });

  fastify.get("/health", async () => health(app));
  fastify.get("/sources", async () => listSources(app));

  fastify.get("/sessions", async (req) => {
    const q = req.query as { harness?: string; project?: string; repo?: string; since?: string };
    const sessions = await listSessions(app, { harness: q.harness, project: q.project, repo: q.repo });
    if (q.since) return sessions.filter((s) => s.startedAt >= q.since!);
    return sessions;
  });

  fastify.get("/search", async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    if (!q.q?.trim()) return reply.code(400).send({ error: 'bad_request: missing "q"' });
    // Federation loop guard (see remotes.ts): honor the incoming chain.
    const chain = String(req.headers["x-gateway-chain"] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    try {
      return await searchOnce(
        app,
        q.q,
        {
          project: q.project,
          repo: q.repo,
          harness: q.harness as Harness | undefined,
          sessionId: q.sessionId,
          scope: q.scope,
          callerSessionId: q.callerSessionId,
          callerPrincipal: (req.headers["x-gateway-principal"] as string | undefined) ?? q.principal,
          asOf: q.asOf,
          includeSuperseded: q.includeSuperseded === "true",
          maxResults: q.maxResults ? Number(q.maxResults) : undefined,
          maxTurns: q.maxTurns ? Number(q.maxTurns) : undefined,
          maxTokens: q.maxTokens ? Number(q.maxTokens) : undefined,
        },
        chain,
      );
    } catch (e) {
      const { code, message } = toStatus(e);
      return reply.code(code).send({ error: message });
    }
  });

  fastify.get("/decide", async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    if (!q.q?.trim()) return reply.code(400).send({ error: 'bad_request: missing "q"' });
    try {
      return await decideOnce(app, q.q, {
        project: q.project,
        repo: q.repo,
        harness: q.harness as Harness | undefined,
        maxDecisions: q.maxDecisions ? Number(q.maxDecisions) : undefined,
      });
    } catch (e) {
      const { code, message } = toStatus(e);
      return reply.code(code).send({ error: message });
    }
  });

    fastify.get("/related", async (req, reply) => {
    const q = req.query as { artifact?: string; limit?: string };
    if (!q.artifact?.trim()) return reply.code(400).send({ error: 'bad_request: missing "artifact"' });
    try {
      return await getRelated(app, q.artifact, q.limit ? Number(q.limit) : undefined);
    } catch (e) {
      const { code, message } = toStatus(e);
      return reply.code(code).send({ error: message });
    }
  });

  fastify.get("/artifacts/graph", async (req, reply) => {
    const q = req.query as { artifact?: string; maxDepth?: string };
    if (!q.artifact?.trim()) return reply.code(400).send({ error: 'bad_request: missing "artifact"' });
    try {
      return await traverseArtifacts(app, q.artifact, q.maxDepth ? Number(q.maxDepth) : 2);
    } catch (e) {
      const { code, message } = toStatus(e);
      return reply.code(code).send({ error: message });
    }
  });

  fastify.get("/sessions/:harness/:id", async (req, reply) => {    const p = req.params as { harness: string; id: string };
    try {
      return await getSession(app, p.harness, p.id);
    } catch (e) {
      const { code, message } = toStatus(e);
      return reply.code(code).send({ error: message });
    }
  });

  fastify.get("/sessions/:harness/:id/turns/:turnId", async (req, reply) => {
    const p = req.params as { harness: string; id: string; turnId: string };
    const q = req.query as { window?: string };
    try {
      if (q.window !== undefined) {
        return await getContext(app, p.harness, p.id, decodeURIComponent(p.turnId));
      }
      return await getTurn(app, p.harness, p.id, decodeURIComponent(p.turnId));
    } catch (e) {
      const { code, message } = toStatus(e);
      return reply.code(code).send({ error: message });
    }
  });

  fastify.post("/sync", async (req) => {
    const q = req.query as { rebuild?: string; embed?: string };
    return syncNow(app, q.rebuild === "true" || q.rebuild === "1", { embed: q.embed === "true" || q.embed === "1" });
  });

  fastify.post("/sessions/:harness/:id/sync", async (req, reply) => {
    const p = req.params as { harness: string; id: string };
    const q = req.query as { embed?: string; parent?: string };
    try {
      return await syncSession(app, p.harness, p.id, { embed: q.embed === "true" || q.embed === "1", parent: q.parent });
    } catch (e) {
      const { code, message } = toStatus(e);
      return reply.code(code).send({ error: message });
    }
  });

  fastify.post("/backfill", async (req) => {
    const q = req.query as { batch?: string; maxSessions?: string };
    return backfillEmbeddings(app, {
      batchSize: q.batch ? Number(q.batch) : 64,
      maxSessions: q.maxSessions ? Number(q.maxSessions) : undefined,
    });
  });

  fastify.get("/topology", async (req) => {
    const q = req.query as { harness?: string; sessionId?: string };
    return showTopology(app, { harness: q.harness, sessionId: q.sessionId });
  });

  fastify.post("/topology/link", async (req, reply) => {
    const q = req.query as { ph: string; ps: string; ch: string; cs: string };
    try {
      return linkSessions(app, q.ph, q.ps, q.ch, q.cs);
    } catch (e) {
      const { code, message } = toStatus(e);
      return reply.code(code).send({ error: message });
    }
  });

  fastify.post("/topology/unlink", async (req, reply) => {
    const q = req.query as { ph: string; ps: string; ch: string; cs: string };
    try {
      return unlinkSessions(app, q.ph, q.ps, q.ch, q.cs);
    } catch (e) {
      const { code, message } = toStatus(e);
      return reply.code(code).send({ error: message });
    }
  });

  fastify.post("/feedback", async (req, reply) => {
    const q = req.query as { turnId?: string; helpful?: string; note?: string };
    if (!q.turnId) return reply.code(400).send({ error: 'bad_request: missing "turnId"' });
    if (q.helpful !== "true" && q.helpful !== "false") {
      return reply.code(400).send({ error: 'bad_request: helpful must be "true" or "false"' });
    }
    try {
      return recordFeedback(app, q.turnId, q.helpful === "true", q.note);
    } catch (e) {
      const { code, message } = toStatus(e);
      return reply.code(code).send({ error: message });
    }
  });

  fastify.get("/temporal/invalidations", async () => {
    return listInvalidations(app);
  });

  fastify.post("/temporal/invalidate", async (req, reply) => {
    const b = (req.body ?? {}) as {
      supersededTurnId?: string;
      supersedingTurnId?: string;
      reason?: string;
      supersededAt?: string;
      sourceSessionId?: string;
    };
    if (!b.supersededTurnId || !b.supersedingTurnId) {
      return reply.code(400).send({ error: 'bad_request: missing supersededTurnId or supersedingTurnId' });
    }
    try {
      return recordInvalidation(
        app,
        b.supersededTurnId,
        b.supersedingTurnId,
        b.reason ?? "Superseded",
        b.supersededAt ?? new Date().toISOString(),
        b.sourceSessionId ?? "unknown",
      );
    } catch (e) {
      const { code, message } = toStatus(e);
      return reply.code(code).send({ error: message });
    }
  });

  fastify.post("/hooks/git", async (req, reply) => {
    const b = (req.body ?? {}) as Partial<GitCommitEvent>;
    if (!b.repo || !b.sha) {
      return reply.code(400).send({ error: 'bad_request: missing repo or sha' });
    }
    const event: GitCommitEvent = {
      repo: b.repo,
      sha: b.sha,
      branch: b.branch ?? "main",
      message: b.message ?? "",
      files: Array.isArray(b.files) ? b.files : String(b.files ?? "").split(",").filter(Boolean),
      timestamp: b.timestamp ?? new Date().toISOString(),
    };
    return handleGitCommitEvent(app, event);
  });

  fastify.get("/acl/rules", async () => {
    return listAclRules(app);
  });

  fastify.post("/acl/rules", async (req, reply) => {
    const b = req.body as import("../security/acl.js").AccessRule | undefined;
    if (!b?.principal) {
      return reply.code(400).send({ error: 'bad_request: missing principal in body' });
    }
    return setAclRule(app, b);
  });

  fastify.delete("/acl/rules/:principal", async (req) => {
    const p = req.params as { principal: string };
    return removeAclRule(app, p.principal);
  });

  fastify.get("/live", async (req, reply) => {
    const q = req.query as { q?: string; windowMs?: string };
    if (!q.q?.trim()) return reply.code(400).send({ error: 'bad_request: missing "q"' });
    return searchLive(app, q.q, { activeWindowMs: q.windowMs ? Number(q.windowMs) : undefined });
  });

  fastify.get("/topology/lineage", async (req, reply) => {
    const q = req.query as { harness?: string; session?: string };
    if (!q.harness || !q.session) {
      return reply.code(400).send({ error: 'bad_request: missing "harness" or "session"' });
    }
    try {
      return getLineage(app, q.harness, q.session);
    } catch (e) {
      const { code, message } = toStatus(e);
      return reply.code(code).send({ error: message });
    }
  });

  fastify.get("/subscriptions", async () => {
    return listSubscriptions(app);
  });

  fastify.post("/subscriptions", async (req, reply) => {
    const b = (req.body ?? {}) as { query?: string; harness?: string; webhookUrl?: string };
    if (!b.query?.trim()) return reply.code(400).send({ error: 'bad_request: missing "query"' });
    return createSubscription(app, b.query, { harness: b.harness, webhookUrl: b.webhookUrl });
  });

  fastify.delete("/subscriptions/:id", async (req) => {
    const p = req.params as { id: string };
    return cancelSubscription(app, p.id);
  });

  return fastify;
}

export async function serveHttp(app: GatewayApp, port = 3000): Promise<FastifyInstance> {
  const server = buildHttpServer(app);
  // MVP security: loopback only. Never bind 0.0.0.0 (remote = Phase 2 + auth).
  await server.listen({ port, host: "127.0.0.1" });
  return server;
}

/**
 * Production serve wrapper: owns the global port file + cleanup.
 * serveHttp itself stays side-effect-free so tests/scripts can't clobber it.
 */
export async function serveProduction(app: GatewayApp, port = 3000): Promise<FastifyInstance> {
  const server = buildHttpServer(app);
  server.addHook("onClose", async () => clearServeInfo());
  await server.listen({ port, host: "127.0.0.1" });
  writeServeInfo({ port, pid: process.pid });
  return server;
}
