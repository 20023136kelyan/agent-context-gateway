import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { ItemStore, SCHEMA_VERSION } from "../src/store/store.js";
import { ItemError, parseAnchor, formatAnchor, normalizePath, type NewItem } from "../src/store/items.js";

const REPO = "/work/ledgerline";
const base: NewItem = {
  repo: REPO,
  type: "preference",
  text: "CSV files for finance use ';' as the delimiter.",
  anchor: { kind: "folder", path: "src/exports" },
  source: { kind: "hand", author: "kelyan" },
};

describe("anchors", () => {
  it("parses the short forms people type", () => {
    expect(parseAnchor("")).toEqual({ kind: "project" });
    expect(parseAnchor(".")).toEqual({ kind: "project" });
    expect(parseAnchor("src/exports/")).toEqual({ kind: "folder", path: "src/exports/" });
    expect(parseAnchor("./src/lib/money.js")).toEqual({ kind: "file", path: "src/lib/money.js" });
    expect(parseAnchor("src/authClient.js#AuthClient.refreshSession")).toEqual({ kind: "symbol", path: "src/authClient.js", symbol: "AuthClient.refreshSession" });
    expect(formatAnchor(parseAnchor("src/a.ts#f"))).toBe("src/a.ts › f");
  });

  it("keeps anchors inside the repository", () => {
    expect(() => normalizePath("/etc/passwd")).toThrow(ItemError);
    expect(() => normalizePath("src/../../secrets")).toThrow(/leaves the repository/);
    expect(() => normalizePath("C:/x")).toThrow(ItemError);
    expect(normalizePath("src\\lib\\a.ts")).toBe("src/lib/a.ts");
  });
});

describe("item store", () => {
  let dir: string;
  let clock: Date;
  let store: ItemStore;
  const tick = (ms = 1000) => (clock = new Date(clock.getTime() + ms));

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bifrost-store-"));
    clock = new Date("2026-10-01T10:00:00.000Z");
    store = new ItemStore(join(dir, "bifrost.db"), () => clock);
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips an item with its anchor, evidence and defaults", () => {
    const item = store.add({
      ...base,
      anchor: { kind: "symbol", path: "src/authClient.js", symbol: "AuthClient.refreshSession", lines: [40, 60] },
      evidence: [{ kind: "message", ref: "opencode:ses_1:msg_9", detail: "no, we always use ';'" }],
    });
    expect(item.id).toMatch(/^itm_[0-9a-f]{16}$/);
    expect(store.get(item.id)).toEqual(item);
    expect(item).toMatchObject({
      anchor: { kind: "symbol", path: "src/authClient.js", symbol: "AuthClient.refreshSession", lines: [40, 60] },
      evidence: [{ kind: "message", ref: "opencode:ses_1:msg_9", detail: "no, we always use ';'" }],
      confidence: 1,
      status: "active",
      votes: { up: 0, down: 0 },
      validFrom: "2026-10-01T10:00:00.000Z",
    });
    expect(store.add(base).anchor).toEqual({ kind: "folder", path: "src/exports/" });
  });

  it("rejects items that delivery could not use", () => {
    expect(() => store.add({ ...base, text: "x".repeat(281) })).toThrow(/limit is 280/);
    expect(() => store.add({ ...base, text: "   " })).toThrow(/empty/);
    expect(() => store.add({ ...base, type: "gossip" as never })).toThrow(/unknown item type/);
    expect(() => store.add({ ...base, anchor: { kind: "file", path: "../x.js" } })).toThrow(/leaves the repository/);
    expect(() => store.add({ ...base, confidence: 2 })).toThrow(/confidence/);
    expect(store.list()).toEqual([]);
  });

  it("generated items start less certain than hand-written ones", () => {
    expect(store.add({ ...base, source: { kind: "generated" } }).confidence).toBe(0.5);
  });

  it("filters and returns only what is valid now", () => {
    const a = store.add(base);
    const b = store.add({ ...base, type: "warning", text: "Never call signOut from an interceptor." });
    store.add({ ...base, repo: "/work/other" });
    store.add({ ...base, status: "pending-review", text: "Maybe use cents." });
    expect(store.list({ repo: REPO }).map((i) => i.id)).toHaveLength(3);
    expect(store.list({ repo: REPO, type: "warning" }).map((i) => i.id)).toEqual([b.id]);
    expect(store.activeAt(REPO).map((i) => i.id)).toEqual([a.id, b.id]);
    tick();
    store.retire(a.id, "convention changed");
    expect(store.activeAt(REPO).map((i) => i.id)).toEqual([b.id]);
    expect(store.activeAt(REPO, new Date("2026-10-01T10:00:00.500Z")).map((i) => i.id)).toEqual([b.id]);
    expect(store.get(a.id)).toMatchObject({ status: "retired", validUntil: "2026-10-01T10:00:01.000Z", evidence: [{ kind: "note", ref: "retired", detail: "convention changed" }] });
  });

  it("supersedes an item with a successor, keeping the old one as history", () => {
    const old = store.add(base);
    tick();
    const { old: ended, replacement } = store.supersede(old.id, { ...base, text: "CSV files for finance use ',' since the move to Excel 365." });
    expect(ended).toMatchObject({ status: "retired", supersededBy: replacement.id, validUntil: "2026-10-01T10:00:01.000Z" });
    expect(store.activeAt(REPO).map((i) => i.id)).toEqual([replacement.id]);
    expect(() => store.supersede(replacement.id, { ...base, repo: "/elsewhere" })).toThrow(/same repository/);
  });

  it("rolls back a supersession whose replacement is invalid", () => {
    const old = store.add(base);
    expect(() => store.supersede(old.id, { ...base, text: "" })).toThrow(/empty/);
    expect(store.get(old.id)).toMatchObject({ status: "active" });
    expect(store.list()).toHaveLength(1);
  });

  it("edits, votes and gathers evidence", () => {
    const item = store.add(base);
    tick();
    const edited = store.edit(item.id, { text: "Finance CSVs: ';' delimiter.", anchor: { kind: "file", path: "src/exports/invoicesCsv.js" } });
    expect(edited).toMatchObject({ text: "Finance CSVs: ';' delimiter.", anchor: { kind: "file", path: "src/exports/invoicesCsv.js" }, updatedAt: "2026-10-01T10:00:01.000Z" });
    expect(() => store.edit(item.id, { text: "y".repeat(300) })).toThrow(/limit/);
    store.vote(item.id, "up");
    store.vote(item.id, "down");
    expect(store.vote(item.id, "up").votes).toEqual({ up: 2, down: 1 });
    expect(store.addEvidence(item.id, { kind: "outcome", ref: "run-42", detail: "tests pass" }).evidence).toHaveLength(1);
    expect(() => store.vote("itm_missing", "up")).toThrow(/no item/);
  });

  it("migrates once and refuses a schema from a newer version", () => {
    expect(store.schemaVersion).toBe(SCHEMA_VERSION);
    const item = store.add(base);
    store.close();
    store = new ItemStore(join(dir, "bifrost.db"), () => clock);
    expect(store.schemaVersion).toBe(SCHEMA_VERSION);
    expect(store.get(item.id)?.text).toBe(base.text);
    store.close();
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
    const raw = new DatabaseSync(join(dir, "bifrost.db"));
    raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    raw.close();
    expect(() => new ItemStore(join(dir, "bifrost.db"))).toThrow(/newer than this version/);
    store = new ItemStore(":memory:");
  });
});
