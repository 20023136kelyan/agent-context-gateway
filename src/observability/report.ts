/**
 * Opt-in aggregate reporter: the ONLY thing ever allowed to leave the machine.
 *
 * Payload = UsageAggregate (counts, buckets, percentiles) + coarse environment
 * facts (platform, node, component names). Per-request rows NEVER leave:
 * this module cannot see usage.jsonl lines, only the aggregate function, by
 * construction (it imports aggregateUsage, not readFileSync-on-rows).
 *
 * Default off everywhere (settings.telemetry), and there is no built-in
 * endpoint: reports go only to GATEWAY_TELEMETRY_URL. The default used to be
 * telemetry.context-gateway.dev, a domain that did not resolve (2026-09-23)
 * and that nobody here controls: whoever registered it would have received
 * every opted-in user's report. Fail-silent with a boolean outcome: telemetry
 * must never break serving or installs.
 */
import { aggregateUsage, defaultUsagePath } from "./usage.js";

/** Where reports go, or null: nothing is sent until an endpoint is configured. */
export function telemetryUrl(): string | null {
  return process.env.GATEWAY_TELEMETRY_URL?.trim() || null;
}

export interface TelemetryReport {
  sentAt: string;
  env: {
    platform: string;
    node: string;
    backend: string;
    engine: string | null;
    reranker: string | null;
    judge: string | null;
  };
  usage: ReturnType<typeof aggregateUsage>;
}

export function buildReport(
  stateDir?: string,
  parts?: { backend?: string; engine?: string | null; reranker?: string | null; judge?: string | null },
): TelemetryReport {
  return {
    sentAt: new Date().toISOString(),
    env: {
      platform: process.platform,
      node: process.version,
      backend: parts?.backend ?? "unknown",
      engine: parts?.engine ?? null,
      reranker: parts?.reranker ?? null,
      judge: parts?.judge ?? null,
    },
    usage: aggregateUsage(defaultUsagePath(stateDir)),
  };
}

/** POST the aggregate if (and only if) the caller already checked opt-in. */
export async function flushReport(
  report: TelemetryReport,
  url: string | null = telemetryUrl(),
  timeoutMs = 10000,
): Promise<boolean> {
  if (!url) return false;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(report),
      signal: ac.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
