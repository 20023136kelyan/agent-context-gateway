/**
 * Opt-in aggregate reporter: the ONLY thing ever allowed to leave the machine.
 *
 * Payload = UsageAggregate (counts, buckets, percentiles) + coarse environment
 * facts (platform, node, component names). Per-request rows NEVER leave:
 * this module cannot see usage.jsonl lines, only the aggregate function, by
 * construction (it imports aggregateUsage, not readFileSync-on-rows).
 *
 * Default off everywhere (settings.telemetry). Endpoint override for
 * self-hosters: GATEWAY_TELEMETRY_URL. Fail-silent with a boolean outcome —
 * telemetry must never break serving or installs.
 */
import { aggregateUsage, defaultUsagePath } from "./usage.js";

export const DEFAULT_TELEMETRY_URL = "https://telemetry.context-gateway.dev/v1/report";

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
  url = process.env.GATEWAY_TELEMETRY_URL ?? DEFAULT_TELEMETRY_URL,
  timeoutMs = 10000,
): Promise<boolean> {
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
