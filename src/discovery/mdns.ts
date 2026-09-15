/**
 * P3 mDNS auto-discovery — gateways announce `_context-gateway._tcp` on the
 * LAN; `remotes-discover` browses and prints candidates (never auto-adds:
 * joining a federation is an explicit, token-bearing act).
 */
import { Bonjour, type Service } from "bonjour-service";

export const GATEWAY_SERVICE = "context-gateway";

export interface DiscoveredGateway {
  name: string;
  host: string;
  port: number;
  backend?: string;
  docCount?: number;
}

export function announce(port: number, info: { backend?: string; docCount?: number } = {}): { stop: () => void } {
  const bonjour = new Bonjour();
  const service = bonjour.publish({
    name: `context-gateway-${port}`,
    type: GATEWAY_SERVICE,
    port,
    txt: {
      backend: info.backend ?? "tantivy",
      docs: String(info.docCount ?? 0),
    },
  });
  return {
    stop: () => {
      try {
        service.stop();
      } catch {
        // ignore
      }
      bonjour.unpublishAll(() => bonjour.destroy());
    },
  };
}

function toDiscovered(service: Service): DiscoveredGateway | null {
  const port = service.port;
  if (!port) return null;
  const host = service.referer?.address ?? service.host ?? "127.0.0.1";
  return {
    name: service.name,
    host,
    port,
    backend: service.txt?.backend,
    docCount: service.txt?.docs ? Number(service.txt.docs) : undefined,
  };
}

export function discover(timeoutMs = 5000): Promise<DiscoveredGateway[]> {
  const bonjour = new Bonjour();
  return new Promise((resolve) => {
    const found = new Map<string, DiscoveredGateway>();
    const browser = bonjour.find({ type: GATEWAY_SERVICE }, (service) => {
      const d = toDiscovered(service);
      if (d) found.set(`${d.host}:${d.port}`, d);
    });
    setTimeout(() => {
      try {
        browser.stop();
      } catch {
        // ignore
      }
      bonjour.destroy();
      resolve([...found.values()]);
    }, timeoutMs);
  });
}
