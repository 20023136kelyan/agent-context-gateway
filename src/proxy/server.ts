/**
 * Key proxy: runs the gateway's vendor calls on the operator's keys, for
 * users who would rather not hold their own (the paid and free tiers).
 *
 * A user's gateway keeps its histories and index on the user's machine; only
 * the calls it would have made to Voyage or Jev come here (src/vendors.ts
 * routes them). For each call, in order:
 *
 *   1. identity: a Bearer key issued to one user (ProxyStore)
 *   2. model allowlist: only models with a known price may run on our keys
 *   3. quota: this month's metered cost must be under the plan's limit
 *   4. rate limit: per user, per minute
 *   5. scrub: secrets removed again, so even an outdated client cannot pass
 *      raw credentials through (src/security/scrub.ts)
 *   6. forward on the operator's key; meter from the vendor's own token count
 *
 * No-logging policy: request and response bodies are never stored or logged.
 * The one log line per call holds user id, route, status, tokens and latency.
 */
import Fastify, { type FastifyInstance } from "fastify";
import { scrubDeep, scrubText } from "../security/scrub.js";
import { ProxyStore, monthOf, type Plan } from "./store.js";

export type ProxyRoute = "voyage-embeddings" | "voyage-context" | "voyage-rerank" | "jev";

/**
 * $ per million tokens, from the vendors' published tables (2026). A model is
 * allowed only if it is here: unknown models are refused, not billed at a
 * guess, so a client cannot spend the operator's key on something pricier.
 */
export const PRICE_PER_M: Record<string, number> = {
  "voyage-4": 0.06,
  "voyage-code-4": 0.12,
  "voyage-context-4": 0.12,
  "rerank-2.5": 0.05,
  "rerank-2.5-lite": 0.02,
  "rerank-3": 0.05,
  "rerank-3-lite": 0.02,
  // Jev bills input tokens; output is free. Its model name is not a price key.
  jev: 0.042,
};

export interface ProxyConfig {
  store: ProxyStore;
  voyageKey?: string;
  jevKey?: string;
  voyageBase?: string;
  jevUrl?: string;
  /** Monthly limit in micro-dollars, per plan. */
  limits?: Record<Plan, number>;
  /** Requests per user per minute. */
  rpm?: number;
  timeoutMs?: number;
  /** One line per call; never receives bodies. */
  log?: (line: Record<string, unknown>) => void;
}

/**
 * Defaults pending a pricing decision: $0.60/month free (about 1,000
 * Jev-reranked searches at the measured ~$0.0006 each), $20/month paid.
 */
export function defaultLimits(): Record<Plan, number> {
  const usd = (v: string | undefined, d: number) => Math.round((Number.isFinite(Number(v)) && v ? Number(v) : d) * 1e6);
  return { free: usd(process.env.ACG_PROXY_FREE_USD, 0.6), paid: usd(process.env.ACG_PROXY_PAID_USD, 20) };
}

const UPSTREAM_PATH: Record<Exclude<ProxyRoute, "jev">, string> = {
  "voyage-embeddings": "/embeddings",
  "voyage-context": "/contextualizedembeddings",
  "voyage-rerank": "/rerank",
};

/** Remove secrets from the parts of each payload that carry user text. */
function scrubPayload(route: ProxyRoute, body: Record<string, unknown>): Record<string, unknown> {
  switch (route) {
    case "voyage-embeddings":
      return { ...body, input: Array.isArray(body.input) ? body.input.map((s) => (typeof s === "string" ? scrubText(s) : s)) : body.input };
    case "voyage-context":
      return { ...body, inputs: scrubDeep(body.inputs) };
    case "voyage-rerank":
      return {
        ...body,
        query: typeof body.query === "string" ? scrubText(body.query) : body.query,
        documents: scrubDeep(body.documents),
      };
    case "jev":
      return { ...body, state: scrubDeep(body.state) };
  }
}

function priceKey(route: ProxyRoute, body: Record<string, unknown>): string | null {
  if (route === "jev") return "jev";
  return typeof body.model === "string" ? body.model : null;
}

/** Tokens the vendor says it billed: Voyage `usage.total_tokens`, Jev `usage.input_tokens`. */
function billedTokens(route: ProxyRoute, response: unknown): number {
  const u = (response as { usage?: Record<string, unknown> } | null)?.usage ?? {};
  const n = route === "jev" ? u.input_tokens : u.total_tokens;
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
}

export function buildProxyServer(cfg: ProxyConfig): FastifyInstance {
  const store = cfg.store;
  const limits = cfg.limits ?? defaultLimits();
  const rpm = cfg.rpm ?? Number(process.env.ACG_PROXY_RPM ?? 600);
  const timeoutMs = cfg.timeoutMs ?? 30_000;
  const voyageBase = (cfg.voyageBase ?? "https://api.voyageai.com/v1").replace(/\/+$/, "");
  const jevUrl = cfg.jevUrl ?? "https://api.typesafe.ai/v1/systemone";
  const log = cfg.log ?? ((line) => process.stderr.write(`${JSON.stringify(line)}\n`));
  const windows = new Map<string, { start: number; count: number }>();

  // No Fastify logger at all: its request logs would record URLs and headers.
  // The only log is the metadata line written by `done` below.
  const app = Fastify({ logger: false, bodyLimit: 4 * 1024 * 1024 });

  app.get("/health", async () => ({ ok: true, routes: { voyage: Boolean(cfg.voyageKey), jev: Boolean(cfg.jevKey) } }));

  app.get("/v1/usage", async (req, reply) => {
    const user = store.authenticate(bearer(req.headers.authorization));
    if (!user) return reply.code(401).send({ error: "unauthorized" });
    const used = store.monthUsage(user.id);
    return { plan: user.plan, month: used.month, usedUsd: used.microUsd / 1e6, limitUsd: limits[user.plan] / 1e6, byRoute: used.byRoute };
  });

  const routes: [ProxyRoute, string][] = [
    ["voyage-embeddings", "/v1/voyage/embeddings"],
    ["voyage-context", "/v1/voyage/contextualizedembeddings"],
    ["voyage-rerank", "/v1/voyage/rerank"],
    ["jev", "/v1/jev"],
  ];
  for (const [route, path] of routes) {
    app.post(path, async (req, reply) => {
      const t0 = Date.now();
      const done = (status: number, userId: string | null, tokens = 0) =>
        log({ ts: new Date().toISOString(), user: userId, route, status, tokens, ms: Date.now() - t0 });

      const user = store.authenticate(bearer(req.headers.authorization));
      if (!user) {
        done(401, null);
        return reply.code(401).send({ error: "unauthorized", detail: "missing, unknown or revoked proxy key" });
      }
      const upstreamKey = route === "jev" ? cfg.jevKey : cfg.voyageKey;
      if (!upstreamKey) {
        done(503, user.id);
        return reply.code(503).send({ error: "route_unavailable", detail: `this proxy has no ${route === "jev" ? "Jev" : "Voyage"} key` });
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const model = priceKey(route, body);
      if (!model || PRICE_PER_M[model] === undefined) {
        done(400, user.id);
        return reply.code(400).send({ error: "model_not_allowed", detail: `model ${JSON.stringify(body.model)} is not offered by this proxy` });
      }
      const used = store.monthUsage(user.id);
      const limit = limits[user.plan];
      if (used.microUsd >= limit) {
        done(429, user.id);
        return reply.code(429).send({
          error: "quota_exceeded",
          detail: `the ${user.plan} plan's monthly allowance is used up`,
          usedUsd: used.microUsd / 1e6, limitUsd: limit / 1e6, month: monthOf(),
        });
      }
      const now = Date.now();
      const w = windows.get(user.id);
      if (!w || now - w.start >= 60_000) windows.set(user.id, { start: now, count: 1 });
      else if (++w.count > rpm) {
        done(429, user.id);
        return reply.code(429).header("retry-after", String(Math.ceil((w.start + 60_000 - now) / 1000))).send({ error: "rate_limited" });
      }

      const url = route === "jev" ? jevUrl : `${voyageBase}${UPSTREAM_PATH[route]}`;
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      let res: Response;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${upstreamKey}` },
          body: JSON.stringify(scrubPayload(route, body)),
          signal: ac.signal,
        });
      } catch {
        done(504, user.id);
        return reply.code(504).send({ error: "upstream_unavailable" });
      } finally {
        clearTimeout(timer);
      }
      const text = await res.text();
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        // pass the vendor's body through as-is
      }
      const tokens = res.ok ? billedTokens(route, parsed) : 0;
      if (res.ok) store.record(user.id, route, tokens, (tokens * PRICE_PER_M[model]) /* $/M tokens -> micro-$ */);
      done(res.status, user.id, tokens);
      const after = store.monthUsage(user.id).microUsd;
      return reply
        .code(res.status)
        .header("content-type", res.headers.get("content-type") ?? "application/json")
        .header("x-acg-used-usd", (after / 1e6).toFixed(6))
        .header("x-acg-limit-usd", (limit / 1e6).toFixed(2))
        .send(text);
    });
  }
  return app;
}

function bearer(header: string | string[] | undefined): string | undefined {
  const h = Array.isArray(header) ? header[0] : header;
  const m = /^Bearer\s+(.+)$/i.exec(h ?? "");
  return m?.[1]?.trim();
}
