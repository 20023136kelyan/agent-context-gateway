/**
 * The local daemon: one process per machine that keeps the delivery engine warm, so
 * a hook answers in milliseconds instead of opening the store on every tool call.
 * Listens on 127.0.0.1 only and requires the `x-bifrost` header, which a web page
 * cannot send to it without a CORS preflight the daemon never answers.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DeliveryEngine, type SessionEvent, type ToolEvent } from "../delivery/engine.js";
import { ItemStore } from "../store/store.js";
import { DEFAULT_PORT, daemonInfoPath, defaultStorePath, readDaemonInfo, type DaemonInfo } from "../paths.js";
export { daemonInfoPath, readDaemonInfo, type DaemonInfo };

export const VERSION = "0.3.0";
const MAX_BODY = 1 << 20;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const str = (v: unknown, fallback = ""): string => (typeof v === "string" && v ? v : fallback);

export interface StartedDaemon {
  server: Server;
  port: number;
  close(): Promise<void>;
}

export async function startDaemon(opts: { store?: ItemStore; storePath?: string; port?: number; infoPath?: string | null } = {}): Promise<StartedDaemon> {
  const storePath = opts.storePath ?? defaultStorePath();
  const store = opts.store ?? new ItemStore(storePath);
  const engine = new DeliveryEngine(store);

  const server = createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      const data = JSON.stringify(body);
      res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(data) });
      res.end(data);
    };
    if (req.headers["x-bifrost"] !== "1") return send(403, { error: "missing x-bifrost header" });
    try {
      if (req.method === "GET" && req.url === "/health") return send(200, { ok: true, version: VERSION, pid: process.pid });
      if (req.method !== "POST") return send(404, { error: "not found" });
      const body = JSON.parse((await readBody(req)) || "{}") as Record<string, unknown>;
      if (req.url === "/tool") {
        const e: ToolEvent = { cwd: str(body.cwd, process.cwd()), session: str(body.session, "unknown"), client: str(body.client, "unknown"), tool: str(body.tool), input: body.input ?? {} };
        return send(200, engine.onTool(e));
      }
      if (req.url === "/session") {
        const e: SessionEvent = { cwd: str(body.cwd, process.cwd()), session: str(body.session, "unknown"), client: str(body.client, "unknown"), explain: body.explain !== false };
        return send(200, engine.onSessionStart(e));
      }
      return send(404, { error: "not found" });
    } catch (err) {
      return send(400, { error: String((err as Error).message ?? err) });
    }
  });

  await new Promise<void>((ok, fail) => {
    server.once("error", fail);
    server.listen(opts.port ?? Number(process.env.BIFROST_PORT ?? DEFAULT_PORT), "127.0.0.1", () => ok());
  });
  const port = (server.address() as { port: number }).port;
  const infoPath = opts.infoPath === undefined ? daemonInfoPath() : opts.infoPath;
  if (infoPath) {
    mkdirSync(dirname(infoPath), { recursive: true });
    const info: DaemonInfo = { pid: process.pid, port, version: VERSION, store: storePath, startedAt: new Date().toISOString() };
    writeFileSync(infoPath, JSON.stringify(info, null, 2));
  }
  return {
    server,
    port,
    close: () =>
      new Promise<void>((done) => {
        server.close(() => {
          if (infoPath && readDaemonInfo(infoPath)?.pid === process.pid) rmSync(infoPath, { force: true });
          if (!opts.store) store.close();
          done();
        });
      }),
  };
}
