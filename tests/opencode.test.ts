/**
 * OpenCode adapter: sessions/turns mapping from a fixture SQLite store.
 * Builds a tiny opencode.db in tmp (same tables the real store has) —
 * never touches the developer's real history.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { OpenCodeAdapter } from "../src/adapters/opencode.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

function fixtureDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "acg-opencode-"));
  const path = join(dir, "opencode.db");
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE project (id TEXT, name TEXT);
    CREATE TABLE session (id TEXT, project_id TEXT, directory TEXT, title TEXT);
    CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
    CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);`);
  db.prepare("INSERT INTO project VALUES (?, ?)").run("proj-1", "demo");
  db.prepare("INSERT INTO session VALUES (?, ?, ?, ?)").run("ses_1", "proj-1", "/repo/demo", "first chat");
  db.prepare("INSERT INTO session VALUES (?, ?, ?, ?)").run("ses_empty", "proj-1", "/repo/demo", "empty");
  const msg = (id: string, sid: string, ts: number, role: string) =>
    db.prepare("INSERT INTO message VALUES (?, ?, ?, ?)").run(id, sid, ts, JSON.stringify({ role }));
  const part = (id: string, mid: string, sid: string, ts: number, type: string, text: string) =>
    db.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?)").run(id, mid, sid, ts, JSON.stringify({ type, text }));
  msg("msg_u1", "ses_1", 1000, "user");
  part("p_u1", "msg_u1", "ses_1", 1001, "text", "how do I run tests?");
  msg("msg_a1", "ses_1", 2000, "assistant");
  part("p_a1", "msg_a1", "ses_1", 2001, "text", "run npm test in the repo root.");
  part("p_a2", "msg_a1", "ses_1", 2002, "step-start", "");
  msg("msg_a2", "ses_1", 3000, "assistant");
  part("p_a3", "msg_a2", "ses_1", 3001, "reasoning", "hmm");
  db.close();
  return path;
}

describe("OpenCodeAdapter", () => {
  it("lists sessions with project names", async () => {
    const a = new OpenCodeAdapter(fixtureDb());
    const ss = await a.listSessions();
    expect(ss.map((s) => s.id).sort()).toEqual(["ses_1", "ses_empty"]);
    expect(ss.find((s) => s.id === "ses_1")?.projectId).toBe("demo");
    expect(ss.every((s) => s.harness === "opencode")).toBe(true);
  });

  it("maps messages+parts to turns, skipping non-text parts and empty messages", async () => {
    const a = new OpenCodeAdapter(fixtureDb());
    const turns = await a.listTurns("ses_1");
    expect(turns.map((t) => t.role)).toEqual(["user", "assistant"]);
    expect(turns[0].content).toBe("how do I run tests?");
    expect(turns[1].content).toBe("run npm test in the repo root.");
    expect(turns[0].timestamp).toBe(new Date(1000).toISOString());
    expect(turns.every((t) => t.sessionId === "ses_1")).toBe(true);
  });

  it("returns empty for missing sessions and missing databases", async () => {
    const a = new OpenCodeAdapter(fixtureDb());
    expect(await a.listTurns("nope")).toEqual([]);
    const missing = new OpenCodeAdapter(join(tmpdir(), "acg-opencode-missing.db"));
    expect(await missing.listSessions()).toEqual([]);
    await expect(missing.getTurn("s", "t")).rejects.toThrow();
  });
});
