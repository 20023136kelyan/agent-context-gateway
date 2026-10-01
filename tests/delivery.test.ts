import { describe, it, expect } from "vitest";
import { fromOpenCodeCall, placesFromToolCall, toRepoPath } from "../src/delivery/places.js";
import { covers, matchItems, rankItems } from "../src/delivery/select.js";
import { age, formatItems, sanitize, SESSION_EXPLANATION } from "../src/delivery/format.js";
import { parseAnchor, type Item, type ItemType } from "../src/store/items.js";
import { ItemStore } from "../src/store/store.js";
import { readKitNotes } from "../src/store/import.js";
import { join } from "node:path";

const NOW = new Date("2026-10-10T12:00:00.000Z");
let n = 0;
function item(type: ItemType, anchor: string, text: string, createdAt = "2026-10-01T00:00:00.000Z"): Item {
  n++;
  return {
    id: `itm_${String(n).padStart(4, "0")}`,
    repo: "/r",
    type,
    text,
    anchor: parseAnchor(anchor),
    evidence: [],
    source: { kind: "hand", author: "kelyan" },
    confidence: 1,
    status: "active",
    validFrom: createdAt,
    votes: { up: 0, down: 0 },
    createdAt,
    updatedAt: createdAt,
  };
}

describe("places", () => {
  const root = "/repo";
  it("maps OpenCode tool calls to Claude Code names and keys", () => {
    expect(fromOpenCodeCall("read", { filePath: "/repo/src/a.js" })).toMatchObject({ tool: "Read", input: { file_path: "/repo/src/a.js" } });
    expect(fromOpenCodeCall("edit", { filePath: "a", oldString: "x", newString: "y" }).input).toMatchObject({ file_path: "a", old_string: "x", new_string: "y" });
    expect(fromOpenCodeCall("apply_patch", { patchText: "*** src/a.js" })).toMatchObject({ tool: "apply_patch", input: { patch: "*** src/a.js" } });
    expect(fromOpenCodeCall("bifrost_at", { path: "x" }).tool).toBe("bifrost_at");
  });

  it("resolves places from tool calls and stays inside the repository", () => {
    expect(placesFromToolCall("Read", { file_path: "/repo/src/a.js", offset: 10, limit: 5 }, root)).toEqual([{ path: "src/a.js", lines: [10, 15] }]);
    expect(placesFromToolCall("Write", { file_path: "src/exports/new.js" }, root)).toEqual([{ path: "src/exports/new.js" }]);
    expect(placesFromToolCall("Read", { file_path: "/elsewhere/a.js" }, root)).toEqual([]);
    expect(placesFromToolCall("Glob", { pattern: "**/*.js", path: "/repo" }, root)).toEqual([]);
    expect(toRepoPath("/repo", root)).toBeNull();
  });

  it("finds known paths in shell commands and patches, folders by their bare name", () => {
    const known = ["src/a.js", "src/b.js", "src/exports/"];
    expect(placesFromToolCall("Bash", { command: "sed -n 1,20p src/a.js" }, root, known).map((p) => p.path)).toEqual(["src/a.js"]);
    expect(placesFromToolCall("Bash", { command: "ls src/exports" }, root, known).map((p) => p.path)).toEqual(["src/exports"]);
    expect(placesFromToolCall("apply_patch", { patch: "*** Update File: src/b.js" }, root, known).map((p) => p.path)).toEqual(["src/b.js"]);
  });
});

describe("matching", () => {
  it("covers by anchor kind", () => {
    expect(covers(parseAnchor(""), { path: "anything.js" })).toBe(true);
    expect(covers(parseAnchor("src/exports/"), { path: "src/exports/new.js" })).toBe(true);
    expect(covers(parseAnchor("src/exports/"), { path: "src/exports" })).toBe(true);
    expect(covers(parseAnchor("src/exports/"), { path: "src/exportsOld.js" })).toBe(false);
    expect(covers({ kind: "file", path: "src/a.js", lines: [40, 60] }, { path: "src/a.js", lines: [1, 20] })).toBe(false);
    expect(covers({ kind: "file", path: "src/a.js", lines: [40, 60] }, { path: "src/a.js", lines: [50, 70] })).toBe(true);
    expect(covers({ kind: "symbol", path: "src/a.js", symbol: "f" }, { path: "src/a.js" })).toBe(true);
  });

  it("leaves project items to session start unless asked", () => {
    const items = [item("preference", "", "Use OpenCode."), item("decision", "src/a.js", "x")];
    expect(matchItems(items, [{ path: "src/a.js" }]).map((i) => i.text)).toEqual(["x"]);
    expect(matchItems(items, [{ path: "src/a.js" }], { includeProject: true })).toHaveLength(2);
  });
});

describe("ranking and formatting", () => {
  it("keeps the note written for this file ahead of broader noise", () => {
    // The noise-test failure: reading invoicesJson.js, two folder notes and a warning
    // took all three slots and the file's own decision never showed.
    const own = item("decision", "src/exports/invoicesJson.js", "New modules use named exports only.");
    const noise = [
      item("warning", "src/exports/", "Exports can be large; no per-row awaits."),
      item("how-to", "src/exports/", "Exports are pure functions over an invoice list."),
      item("warning", "src/exports/", "Keep exports deterministic."),
    ];
    const hits = matchItems([...noise, own], [{ path: "src/exports/invoicesJson.js" }]);
    const { shown, text } = formatItems(hits, { maxItems: 3, now: NOW });
    expect(shown[0]).toBe(own.id);
    expect(text.split("\n")[0]).toBe("BIFRÖST src/exports/invoicesJson.js");
  });

  it("orders by specificity, then type, then newest", () => {
    const a = item("how-to", "src/a.js#f", "symbol how-to");
    const b = item("warning", "src/a.js", "file warning");
    const c = item("decision", "src/a.js", "file decision, older", "2026-09-01T00:00:00.000Z");
    const d = item("decision", "src/a.js", "file decision, newer", "2026-10-05T00:00:00.000Z");
    const e = item("warning", "src/", "folder warning");
    expect(rankItems([e, d, c, b, a]).map((i) => i.text)).toEqual(["symbol how-to", "file warning", "file decision, newer", "file decision, older", "folder warning"]);
  });

  it("formats within the cap and budget, the same way every time", () => {
    const items = [item("warning", "src/a.js", "w".repeat(200)), item("decision", "src/a.js", "d".repeat(200)), item("how-to", "src/b.js", "h".repeat(200))];
    const one = formatItems(items, { maxItems: 3, budgetChars: 500, now: NOW });
    expect(one.shown).toHaveLength(2);
    expect(one.text.length).toBeLessThanOrEqual(500);
    expect(formatItems(items, { maxItems: 3, budgetChars: 500, now: NOW })).toEqual(one);
    expect(one.text).toContain("WARNING");
    expect(one.text).toContain("9d · kelyan");
  });

  it("sanitises text that goes into a model's context", () => {
    expect(sanitize("a\u0007b\n\n c‮ d")).toBe("ab c d");
    expect(sanitize("x".repeat(400))).toHaveLength(280);
    expect(age("2026-10-10T11:59:30.000Z", NOW)).toBe("now");
    expect(age("2026-10-10T09:00:00.000Z", NOW)).toBe("3h");
  });

  it("keeps the session explanation fixed", () => {
    expect(SESSION_EXPLANATION).toMatch(/^This repository has Bifröst/);
    expect(SESSION_EXPLANATION).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });
});

describe("the experiment's notes through the store", () => {
  const TASKS = join(__dirname, "../experiments/upper-bound/tasks");
  const deliver = (store: ItemStore, repo: string, tool: string, input: Record<string, unknown>) => {
    const items = store.activeAt(repo);
    const known = [...new Set(items.flatMap((i) => (i.anchor.kind === "project" ? [] : [i.anchor.path])))];
    return formatItems(matchItems(items, placesFromToolCall(tool, input, "/ws", known)), { now: NOW });
  };

  it("delivers the taste notes when the agent reads the old files they are anchored to", () => {
    const store = new ItemStore(":memory:");
    for (const i of readKitNotes(join(TASKS, "invoice-csv-taste/notes/hand.json"), "/ws")) store.add(i);
    const shown = new Set<string>();
    for (const f of ["src/exports/invoicesJson.js", "src/lib/money.js", "src/lib/dates.js", "src/reports/monthly.js"]) {
      for (const id of deliver(store, "/ws", "Read", { file_path: `/ws/${f}` }).shown) shown.add(store.get(id)!.evidence[0].ref);
    }
    expect([...shown].sort()).toEqual(["imported:tc-1", "imported:tc-2", "imported:tc-3", "imported:tc-4"]);
    store.close();
  });

  it("delivers folder-anchored notes when the agent writes a new file, without reading the old ones", () => {
    const store = new ItemStore(":memory:");
    for (const i of readKitNotes(join(TASKS, "invoice-csv-taste/notes/hand-dir.json"), "/ws")) store.add(i);
    const out = deliver(store, "/ws", "Write", { file_path: "/ws/src/exports/invoicesCsv.js" });
    expect(out.shown).toHaveLength(3);
    expect(out.text.split("\n")[0]).toBe("BIFRÖST src/exports/");
    store.close();
  });

  it("imports the undocumented task's notes with their symbols", () => {
    const items = readKitNotes(join(TASKS, "refresh-rotation-undocumented/notes/hand.json"), "/ws");
    expect(items[0].anchor).toEqual({ kind: "symbol", path: "src/authClient.js", symbol: "AuthClient.refreshSession" });
  });
});
