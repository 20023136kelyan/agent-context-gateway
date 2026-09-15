/**
 * P2e remote federation — read-only: this gateway fans search out to other
 * gateways' HTTP APIs and merges. Remotes never write here; we never write
 * there. Failures are reported per-remote (spec §35), never fabricated.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";

export interface RemoteSource {
  name: string;
  url: string;
  token?: string;
}

export function remotesPath(stateDir?: string): string {
  const base = stateDir ?? process.env.CONTEXT_GATEWAY_STATE ?? `${process.env.HOME ?? "/tmp"}/.context-gateway`;
  return join(base, "remotes.json");
}

export function loadRemotes(stateDir?: string): RemoteSource[] {
  try {
    const p = remotesPath(stateDir);
    if (!existsSync(p)) return [];
    const raw = JSON.parse(readFileSync(p, "utf8")) as { remotes?: RemoteSource[] };
    return Array.isArray(raw.remotes) ? raw.remotes.filter((r) => r.name && r.url) : [];
  } catch {
    return [];
  }
}

function saveRemotes(remotes: RemoteSource[], stateDir?: string): void {
  const p = remotesPath(stateDir);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ remotes }, null, 2), { mode: 0o600 });
  try {
    chmodSync(p, 0o600);
  } catch {
    // best-effort
  }
}

export function addRemote(remote: RemoteSource, stateDir?: string): RemoteSource[] {
  const all = loadRemotes(stateDir).filter((r) => r.name !== remote.name);
  all.push(remote);
  saveRemotes(all, stateDir);
  return all;
}

export function removeRemote(name: string, stateDir?: string): boolean {
  const all = loadRemotes(stateDir);
  const kept = all.filter((r) => r.name !== name);
  if (kept.length === all.length) return false;
  saveRemotes(kept, stateDir);
  return true;
}

export interface RemoteSearchOptions {
  query: string;
  project?: string;
  repo?: string;
  harness?: string;
  maxResults?: number;
}

export interface RemoteResult {
  name: string;
  ok: boolean;
  results: unknown[];
  error?: string;
}

/** Query one remote's /search. Read-only GET; token from stored config. */
export async function queryRemote(
  remote: RemoteSource,
  opts: RemoteSearchOptions,
  timeoutMs = 10000,
  chain: string[] = [],
): Promise<RemoteResult> {
  const params = new URLSearchParams({ q: opts.query });
  if (opts.project) params.set("project", opts.project);
  if (opts.repo) params.set("repo", opts.repo);
  if (opts.harness) params.set("harness", opts.harness);
  if (opts.maxResults) params.set("maxResults", String(opts.maxResults));
  try {
    const headers: Record<string, string> = {
      // Loop guard: gateways skip remotes already in the chain (A->B->A).
      "X-Gateway-Chain": [...chain, remote.name].join(","),
    };
    if (remote.token) headers.Authorization = `Bearer ${remote.token}`;
    const res = await fetch(`${remote.url.replace(/\/$/, "")}/search?${params}`, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { name: remote.name, ok: false, results: [], error: `http ${res.status}` };
    const body = (await res.json()) as { results?: unknown[] };
    return { name: remote.name, ok: true, results: Array.isArray(body.results) ? body.results : [] };
  } catch (e) {
    return { name: remote.name, ok: false, results: [], error: e instanceof Error ? e.message : String(e) };
  }
}
