/**
 * P2a: CLI→HTTP delegation. When `serve` is live, CLI commands become HTTP
 * clients instead of opening a second Tantivy writer (LockBusy otherwise).
 * Discovery via state dir port file; stale files fall back to local.
 */
import { readFileSync, writeFileSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export function stateDir(): string {
  const dir = process.env.CONTEXT_GATEWAY_STATE ?? `${process.env.HOME ?? "/tmp"}/.context-gateway`;
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // read-only contexts still attempt discovery
  }
  return dir;
}

export function portFile(): string {
  return join(stateDir(), "serve.json");
}

export interface ServeInfo {
  port: number;
  pid: number;
  /** Bind address (absent = 127.0.0.1). */
  host?: string;
}

export function readServeInfo(): ServeInfo | null {
  try {
    if (!existsSync(portFile())) return null;
    const raw = JSON.parse(readFileSync(portFile(), "utf8")) as Partial<ServeInfo>;
    if (typeof raw.port !== "number") return null;
    return { port: raw.port, pid: raw.pid ?? 0, host: raw.host };
  } catch {
    return null;
  }
}

/** Where a local client connects to reach a server bound to `host`. */
export function connectHost(host?: string): string {
  if (!host || host === "0.0.0.0" || host === "::") return "127.0.0.1";
  return host;
}

function baseUrl(port: number, host: string): string {
  return `http://${host.includes(":") ? `[${host}]` : host}:${port}`;
}

export function writeServeInfo(info: ServeInfo): void {
  writeFileSync(portFile(), JSON.stringify(info));
}

export function clearServeInfo(): void {
  try {
    rmSync(portFile(), { force: true });
  } catch {
    // ignore
  }
}

/** Probe a live server; null when absent/stale (caller falls back to local). */
export async function probeServer(port: number, timeoutMs = 800, host = "127.0.0.1"): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl(port, host)}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function remoteCall(port: number, method: string, path: string, body?: unknown, host = "127.0.0.1"): Promise<unknown> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const token = process.env.GATEWAY_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  let res: Response;
  try {
    res = await fetch(`${baseUrl(port, host)}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(120000),
    });
  } catch (e) {
    // Unreachable server (stale port file) — caller falls back to local.
    throw new HttpError(0, e instanceof Error ? e.message : String(e));
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new HttpError(res.status, `non-JSON response (old server?): ${text.slice(0, 80)}`);
  }
  if (!res.ok) {
    const msg = (data as { error?: string } | null)?.error ?? `http ${res.status}`;
    throw new HttpError(res.status, msg);
  }
  return data;
}
