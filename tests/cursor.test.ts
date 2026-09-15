/** Cursor adapter tests — synthetic globalStorage state.vscdb (documented 2026 format). */
import { describe, it, expect, beforeAll } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { CursorAdapter, bubbleToTurn } from "../src/adapters/cursor.js";

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

let dbPath: string;
let wsRoot: string;

beforeAll(async () => {
  const root = await mkdtemp(join(tmpdir(), "acg-cursor-"));
  dbPath = join(root, "state.vscdb");
  wsRoot = join(root, "workspaceStorage");
  await mkdir(join(wsRoot, "abc123"), { recursive: true });
  await writeFile(join(wsRoot, "abc123", "workspace.json"), JSON.stringify({ folder: "file:///Users/admin/cozea" }));

  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)");
  db.exec("CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB)");
  db.prepare("INSERT INTO ItemTable(key, value) VALUES (?, ?)").run(
    "composer.composerHeaders",
    JSON.stringify({
      allComposers: [
        { composerId: "comp-1", name: "Fix login", createdAt: "2026-09-10T10:00:00Z", workspaceIdentifier: "abc123" },
        { composerId: "comp-2", title: "Empty draft", createdAt: 1757419200 },
      ],
    }),
  );
  const bubble = (role: string, text: string) => JSON.stringify({ bubbleId: "b", role, text, timestamp: "2026-09-10T10:01:00Z" });
  db.prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)").run("bubbleId:comp-1:b1", bubble("user", "Investigate the login flow in src/auth"));
  db.prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)").run("bubbleId:comp-1:b2", bubble("assistant", "The session cookie is missing Secure flag, see PR #169"));
  db.close();
});

describe("bubbleToTurn", () => {
  it("maps role variants and extracts text", () => {
    expect(bubbleToTurn({ role: "human", text: "hi" })?.role).toBe("user");
    expect(bubbleToTurn({ sender: "ai", content: "hello" })?.text).toBe("hello");
    expect(bubbleToTurn({ type: "tool", text: "" })).toBe(null);
    expect(bubbleToTurn(null)).toBe(null);
  });
});

describe("CursorAdapter", () => {
  it("lists sessions from composerHeaders with workspace projects", async () => {
    const a = new CursorAdapter(dbPath, wsRoot);
    const sessions = await a.listSessions();
    expect(sessions).toHaveLength(2);
    expect(sessions[0].id).toBe("comp-1");
    expect(sessions[0].harness).toBe("cursor");
    expect(sessions[0].projectId).toBe("cozea");
  });

  it("parses bubbles into turns with fileRefs", async () => {
    const a = new CursorAdapter(dbPath, wsRoot);
    const turns = await a.listTurns("comp-1");
    expect(turns.map((t) => t.role)).toEqual(["user", "assistant"]);
    expect(turns[1].fileRefs).toContain("PR #169");
    expect(turns[0].id).toContain("cursor:comp-1");
  });

  it("missing database yields zero sessions, never throws", async () => {
    const a = new CursorAdapter(join(tmpdir(), "nope.vscdb"), join(tmpdir(), "nope-ws"));
    await expect(a.listSessions()).resolves.toEqual([]);
  });
});
