/**
 * How hooks and plugins talk to the daemon. Every call has a short timeout and
 * returns nothing on any failure: Bifröst must never slow down or block an agent.
 * Imports nothing heavy, so a hook process starts fast.
 */
import { connect } from "node:net";
import { readDaemonInfo } from "../paths.js";

export interface Shown {
  text: string;
  shown: string[];
}

const NOTHING: Shown = { text: "", shown: [] };

/**
 * POSTs JSON to the daemon over a plain socket. Hooks start a fresh Node process on
 * every tool call, and loading node:http (or fetch) costs more than the whole
 * request, so this speaks the few lines of HTTP/1.0 the daemon needs through node:net.
 */
export function callDaemon(path: "/tool" | "/session", body: unknown, { timeoutMs = 400, port }: { timeoutMs?: number; port?: number } = {}): Promise<Shown | null> {
  const p = port ?? readDaemonInfo()?.port;
  if (!p) return Promise.resolve(null);
  return new Promise((done) => {
    const data = Buffer.from(JSON.stringify(body), "utf8");
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (v: Shown | null) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      done(v);
    };
    const sock = connect({ host: "127.0.0.1", port: p }, () => {
      sock.write(`POST ${path} HTTP/1.0\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: ${data.length}\r\nx-bifrost: 1\r\n\r\n`);
      sock.end(data);
    });
    sock.setTimeout(timeoutMs, () => finish(null));
    sock.on("data", (c: Buffer) => chunks.push(c));
    sock.on("error", () => finish(null));
    sock.on("close", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const split = raw.indexOf("\r\n\r\n");
      if (split < 0) return finish(null);
      if (!/^HTTP\/1\.[01] 200 /.test(raw)) return finish(NOTHING);
      try {
        const out = JSON.parse(raw.slice(split + 4)) as Partial<Shown>;
        finish({ text: typeof out.text === "string" ? out.text : "", shown: Array.isArray(out.shown) ? out.shown : [] });
      } catch {
        finish(NOTHING);
      }
    });
  });
}

/** Starts the daemon in the background, detached from the calling hook. */
export async function startDaemonDetached(cliPath: string): Promise<void> {
  try {
    const { spawn } = await import("node:child_process");
    const child = spawn(process.execPath, [cliPath, "daemon", "run"], { detached: true, stdio: "ignore", env: process.env });
    child.unref();
  } catch {
    /* fail open */
  }
}

/** Calls the daemon; when none is running, starts one for next time and returns nothing now. */
export async function deliver(path: "/tool" | "/session", body: unknown, cliPath: string, opts: { timeoutMs?: number } = {}): Promise<Shown> {
  const out = await callDaemon(path, body, opts);
  if (out) return out;
  await startDaemonDetached(cliPath);
  return NOTHING;
}
