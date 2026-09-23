/**
 * Where a vendor call goes, and with which key.
 *
 * Per vendor, your own key wins: the call goes straight to the vendor, with
 * no quota. Without one, a configured key proxy (ACG_PROXY_URL +
 * ACG_PROXY_KEY; src/proxy/) carries it on its operator's keys, metered
 * against your plan. With neither, the vendor is unavailable and the gateway
 * degrades exactly as it does without keys. There is no default proxy URL:
 * like telemetry, nothing is sent to a host until you name one.
 */
export type VendorRoute = "voyage-embeddings" | "voyage-context" | "voyage-rerank" | "jev";

const VOYAGE_BASE = () => (process.env.VOYAGE_ENDPOINT ?? "https://api.voyageai.com/v1/embeddings").replace(/\/embeddings\/?$/, "");

const NATIVE: Record<VendorRoute, () => string> = {
  "voyage-embeddings": () => `${VOYAGE_BASE()}/embeddings`,
  "voyage-context": () => `${VOYAGE_BASE()}/contextualizedembeddings`,
  "voyage-rerank": () => `${VOYAGE_BASE()}/rerank`,
  jev: () => process.env.JEV_ENDPOINT ?? "https://api.typesafe.ai/v1/systemone",
};

/** The proxy's path for each route (src/proxy/server.ts serves these). */
export const PROXY_PATH: Record<VendorRoute, string> = {
  "voyage-embeddings": "/v1/voyage/embeddings",
  "voyage-context": "/v1/voyage/contextualizedembeddings",
  "voyage-rerank": "/v1/voyage/rerank",
  jev: "/v1/jev",
};

function ownKey(route: VendorRoute): string | undefined {
  const k = route === "jev" ? process.env.TYPESAFE_API_KEY || process.env.JEV_API_KEY : process.env.VOYAGE_API_KEY;
  return k?.trim() || undefined;
}

export function proxyConfig(): { url: string; key: string } | null {
  const url = process.env.ACG_PROXY_URL?.trim().replace(/\/+$/, "");
  const key = process.env.ACG_PROXY_KEY?.trim();
  return url && key ? { url, key } : null;
}

/** URL and bearer key for one call; `key` is undefined when the vendor is unavailable. */
export function vendorTarget(route: VendorRoute): { url: string; key: string | undefined; via: "own-key" | "proxy" | "none" } {
  const own = ownKey(route);
  if (own) return { url: NATIVE[route](), key: own, via: "own-key" };
  const proxy = proxyConfig();
  if (proxy) return { url: `${proxy.url}${PROXY_PATH[route]}`, key: proxy.key, via: "proxy" };
  return { url: NATIVE[route](), key: undefined, via: "none" };
}

export function vendorAvailable(route: VendorRoute): boolean {
  return vendorTarget(route).key !== undefined;
}
