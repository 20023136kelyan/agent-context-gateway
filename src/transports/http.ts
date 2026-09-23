/**
 * Fastify HTTP transport — loopback only (local-only MVP, no remote).
 * Export buildHttpServer for tests (inject); serveHttp binds 127.0.0.1.
 */
import { rerankDefaultOn } from "../search/reranker.js";
import { timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
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

const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "::1"];

/** Loopback names plus GATEWAY_ALLOWED_HOSTS (comma-separated), lowercased. */
function allowedHosts(): Set<string> {
  const extra = (process.env.GATEWAY_ALLOWED_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
  return new Set([...LOOPBACK_HOSTS, ...extra]);
}

/** Host header -> bare hostname: "localhost:3000" -> "localhost", "[::1]:3000" -> "::1". */
function hostnameOf(host: string | undefined): string {
  if (!host) return "";
  const v6 = host.match(/^\[([^\]]+)\](?::\d+)?$/);
  return (v6 ? v6[1] : host.replace(/:\d+$/, "")).toLowerCase();
}

function tokenMatches(got: string | undefined, want: string): boolean {
  const a = Buffer.from(got ?? "");
  const b = Buffer.from(`Bearer ${want}`);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** A browser write from a page that isn't on an allowed host. CLI, curl and the Swift app send no Origin. */
function isCrossSiteWrite(req: FastifyRequest): boolean {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return false;
  if (req.headers["sec-fetch-site"] === "cross-site") return true;
  const origin = req.headers.origin;
  if (origin === undefined) return false;
  try {
    return !allowedHosts().has(new URL(origin).hostname.replace(/^\[|\]$/g, "").toLowerCase());
  } catch {
    return true; // "null" (sandboxed frames, file://) or malformed
  }
}

export function buildHttpServer(app: GatewayApp): FastifyInstance {
  const fastify = Fastify({ logger: false });
  // Git hooks post URL-encoded fields (see git/hooks.ts).
  fastify.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  });

  // Token-authenticated requests are trusted from anywhere. Everything else
  // must name a loopback Host (DNS rebinding: a hostile page that resolves its
  // own domain to 127.0.0.1 is same-origin to the browser, but its Host header
  // still names that domain) and must not be a browser cross-site write (CSRF).
  // P2e token auth: when GATEWAY_TOKEN is set, every route except liveness
  // needs `Authorization: Bearer <token>`.
  fastify.addHook("onRequest", async (req, reply) => {
    const want = process.env.GATEWAY_TOKEN;
    const authed = !!want && tokenMatches(req.headers.authorization, want);
    const isHealth = req.url === "/health" || req.url.startsWith("/health?");
    if (!authed) {
      if (!allowedHosts().has(hostnameOf(req.headers.host))) {
        if (isHealth) return reply.code(200).send({ ok: true }); // liveness only
        return reply.code(403).send({ error: "forbidden: unrecognized Host (non-loopback access needs GATEWAY_TOKEN)" });
      }
      if (isCrossSiteWrite(req)) return reply.code(403).send({ error: "forbidden: cross-site request" });
    }
    if (isHealth) return;
    if (want && !authed) {
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
          // A daemon cannot see its caller's directory: clients that know
          // their project (the CLI does) pass it, and "*" searches everything.
          defaultProject: q.defaultProject,
          repo: q.repo,
          harness: q.harness as Harness | undefined,
          sessionId: q.sessionId,
          scope: q.scope,
          callerSessionId: q.callerSessionId,
          callerPrincipal: (req.headers["x-gateway-principal"] as string | undefined) ?? q.principal,
          asOf: q.asOf,
          includeSuperseded: q.includeSuperseded === "true",
          semantic: q.semantic === "false" ? false : undefined,
          // Absent = let the registry decide, which is reranker-aware: ON for
          // Jev (0.445 -> 0.489 NDCG@5 on BEIR nfcorpus at 620ms), OFF for the
          // deleted local cross-encoder (0.433 at 6984ms — below plain hybrid). An explicit
          // ?rerank=true/false always wins; GATEWAY_RERANKER=none kills it.
          rerank:
            q.rerank === undefined
              ? rerankDefaultOn(app.reranker)
              : q.rerank !== "false" && q.rerank !== "0",
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
        defaultProject: q.defaultProject,
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
        const w = Number(q.window);
        const window = Number.isInteger(w) && w >= 0 ? Math.min(w, 10) : 3;
        return await getContext(app, p.harness, p.id, decodeURIComponent(p.turnId), window);
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
      // Hooks send one path per line; JSON callers may send a comma list.
      files: Array.isArray(b.files) ? b.files : String(b.files ?? "").split(/\r?\n|,/).map((f) => f.trim()).filter(Boolean),
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
    try {
      return createSubscription(app, b.query, { harness: b.harness, webhookUrl: b.webhookUrl });
    } catch (e) {
      const { code, message } = toStatus(e);
      return reply.code(code).send({ error: message });
    }
  });

  fastify.delete("/subscriptions/:id", async (req) => {
    const p = req.params as { id: string };
    return cancelSubscription(app, p.id);
  });

  return fastify;
}

export function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "::1" || /^127\./.test(host);
}

/** Anything reachable off this machine exposes agent histories: refuse it without a token. */
function assertBindable(host: string): void {
  if (!isLoopbackHost(host) && !process.env.GATEWAY_TOKEN) {
    throw new Error(`bad_request: binding ${host} exposes agent histories to the network; set GATEWAY_TOKEN first`);
  }
}

function boundPort(server: FastifyInstance, fallback: number): number {
  const addr = server.server.address();
  return typeof addr === "object" && addr ? addr.port : fallback;
}

export async function serveHttp(app: GatewayApp, port = 3000, host = "127.0.0.1"): Promise<FastifyInstance> {
  assertBindable(host);
  const server = buildHttpServer(app);
  await server.listen({ port, host });
  return server;
}

/**
 * Production serve wrapper: owns the global port file + cleanup.
 * serveHttp itself stays side-effect-free so tests/scripts can't clobber it.
 */
export async function serveProduction(app: GatewayApp, port = 3000, host = "127.0.0.1"): Promise<FastifyInstance> {
  assertBindable(host);
  const server = buildHttpServer(app);
  server.addHook("onClose", async () => clearServeInfo());
  await server.listen({ port, host });
  writeServeInfo({ port: boundPort(server, port), pid: process.pid, host });
  return server;
}
