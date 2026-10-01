import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ItemStore } from "../src/store/store.js";
import { DeliveryEngine } from "../src/delivery/engine.js";
import { SESSION_EXPLANATION } from "../src/delivery/format.js";
import { parseAnchor, type ItemType } from "../src/store/items.js";

const REPO = "/ws";

describe("delivery engine", () => {
  let store: ItemStore;
  let engine: DeliveryEngine;
  let clock: Date;
  const add = (type: ItemType, anchor: string, text: string) => store.add({ repo: REPO, type, text, anchor: parseAnchor(anchor), source: { kind: "hand", author: "kelyan" } });
  const tool = (session: string, name: string, input: Record<string, unknown>) => engine.onTool({ cwd: REPO, session, client: "test", tool: name, input });

  beforeEach(() => {
    clock = new Date("2026-10-02T09:00:00.000Z");
    store = new ItemStore(":memory:", () => clock);
    engine = new DeliveryEngine(store, { now: () => clock, repoFor: (cwd) => cwd });
  });
  afterEach(() => store.close());

  it("shows an item once per session, and again to another session", () => {
    const w = add("decision", "src/a.js", "Keep the tie-break.");
    expect(tool("s1", "Read", { file_path: "/ws/src/a.js" }).shown).toEqual([w.id]);
    expect(tool("s1", "Read", { file_path: "/ws/src/a.js" }).shown).toEqual([]);
    expect(tool("s2", "Read", { file_path: "src/a.js" }).shown).toEqual([w.id]);
  });

  it("shows a warning again when the agent edits, once", () => {
    const w = add("warning", "src/a.js", "Never retry without the key.");
    const d = add("decision", "src/a.js", "Use named exports.");
    expect(tool("s1", "Read", { file_path: "/ws/src/a.js" }).shown.sort()).toEqual([w.id, d.id].sort());
    expect(tool("s1", "Edit", { file_path: "/ws/src/a.js" }).shown).toEqual([w.id]);
    expect(tool("s1", "Edit", { file_path: "/ws/src/a.js" }).shown).toEqual([]);
  });

  it("picks up items added after it started, by any connection", () => {
    expect(tool("s1", "Read", { file_path: "/ws/src/b.js" }).shown).toEqual([]);
    const late = add("preference", "src/", "Folder convention.");
    expect(tool("s1", "Write", { file_path: "/ws/src/new.js" }).shown).toEqual([late.id]);
  });

  it("stops showing retired items", () => {
    const i = add("decision", "src/a.js", "Old rule.");
    store.retire(i.id);
    expect(tool("s1", "Read", { file_path: "/ws/src/a.js" }).text).toBe("");
  });

  it("starts a session with the fixed explanation, then project items, and never repeats them", () => {
    expect(engine.onSessionStart({ cwd: REPO, session: "s0", client: "test" }).text).toBe(SESSION_EXPLANATION);
    const p = add("preference", "", "Corporate documents keep internal analogies out.");
    const start = engine.onSessionStart({ cwd: REPO, session: "s1", client: "test" });
    expect(start.text.startsWith(`${SESSION_EXPLANATION}\n\nBIFRÖST (project)`)).toBe(true);
    expect(start.shown).toEqual([p.id]);
    expect(tool("s1", "Read", { file_path: "/ws/README.md" }).shown).toEqual([]);
  });

  it("logs every decision locally", () => {
    const i = add("decision", "src/a.js", "x");
    tool("s1", "Read", { file_path: "/ws/src/a.js" });
    tool("s1", "Read", { file_path: "/ws/src/z.js" });
    const log = store.deliveries({ session: "s1" });
    expect(log).toHaveLength(2);
    expect(log[1]).toMatchObject({ event: "tool", tool: "Read", places: ["src/a.js"], matched: [i.id], shown: [i.id], client: "test" });
    expect(log[0]).toMatchObject({ places: ["src/z.js"], shown: [] });
  });

  it("fails open on input it cannot read", () => {
    expect(tool("s1", "Read", null as unknown as Record<string, unknown>)).toEqual({ text: "", shown: [] });
    expect(engine.onTool({ cwd: REPO, session: "s1", client: "t", tool: "Bash", input: { command: 42 } })).toEqual({ text: "", shown: [] });
  });

  it("forgets idle sessions", () => {
    const i = add("decision", "src/a.js", "x");
    tool("s1", "Read", { file_path: "/ws/src/a.js" });
    clock = new Date(clock.getTime() + 25 * 3600_000);
    tool("s9", "Read", { file_path: "/ws/README.md" });
    expect(tool("s1", "Read", { file_path: "/ws/src/a.js" }).shown).toEqual([i.id]);
  });
});

describe("delivery engine across processes", () => {
  it("sees items another connection wrote to the same store file", () => {
    const dir = mkdtempSync(join(tmpdir(), "bifrost-engine-"));
    const file = join(dir, "bifrost.db");
    const daemonSide = new ItemStore(file);
    const cliSide = new ItemStore(file);
    const engine = new DeliveryEngine(daemonSide, { repoFor: (cwd) => cwd });
    try {
      expect(engine.onTool({ cwd: REPO, session: "s", client: "t", tool: "Read", input: { file_path: "/ws/src/a.js" } }).shown).toEqual([]);
      const added = cliSide.add({ repo: REPO, type: "decision", text: "Added from the CLI.", anchor: parseAnchor("src/a.js"), source: { kind: "hand" } });
      expect(engine.onTool({ cwd: REPO, session: "s", client: "t", tool: "Read", input: { file_path: "/ws/src/a.js" } }).shown).toEqual([added.id]);
    } finally {
      daemonSide.close();
      cliSide.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
