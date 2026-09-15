/** P2b topology tests — links, scope fan-out, auto routing. */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp, closeApp, type GatewayApp } from "../src/app.js";
import { TopologyStore, routeAutoScope } from "../src/topology/store.js";
import { searchOnce } from "../src/commands.js";
import { syncAll } from "../src/indexing/sync.js";
import { CursorStore } from "../src/indexing/store.js";

const P = "11111111-1111-1111-1111-111111111111";
const C1 = "22222222-2222-2222-2222-222222222222";
const C2 = "33333333-3333-3333-3333-333333333333";
const U = "44444444-4444-4444-4444-444444444444";

let app: GatewayApp;
let prevState: string | undefined;

function codexSess(id: string, texts: string[]): string {
  return [
    JSON.stringify({ timestamp: "2026-09-10T09:00:00Z", ordinal: 0, type: "session_meta", payload: { session_id: id, cwd: "/repo/cozea" } }),
    ...texts.map((t, i) =>
      JSON.stringify({ timestamp: `2026-09-10T09:${String(i + 1).padStart(2, "0")}:00Z`, ordinal: i + 1, type: "response_item", payload: { type: "message", id: `m${i}`, role: "assistant", content: [{ type: "output_text", text: t }] } }),
    ),
  ].join("\n");
}

beforeAll(async () => {
  prevState = process.env.CONTEXT_GATEWAY_STATE;
  process.env.CONTEXT_GATEWAY_STATE = await mkdtemp(join(tmpdir(), "acg-topo-state-"));
  const root = await mkdtemp(join(tmpdir(), "acg-topo-"));
  const codexDir = join(root, "codex");
  await mkdir(join(codexDir, "2026", "09", "10"), { recursive: true });
  await writeFile(join(codexDir, "2026", "09", "10", `r-p-${P}.jsonl`), codexSess(P, ["Parent architectural vision: workbench isolation folly"]));
  await writeFile(join(codexDir, "2026", "09", "10", `r-c1-${C1}.jsonl`), codexSess(C1, ["Child one implements workbench isolation folly"]));
  await writeFile(join(codexDir, "2026", "09", "10", `r-c2-${C2}.jsonl`), codexSess(C2, ["Child two tests workbench isolation folly"]));
  await writeFile(join(codexDir, "2026", "09", "10", `r-u-${U}.jsonl`), codexSess(U, ["Unrelated quantum teapot documentation"]));
  app = createApp({ indexDir: join(root, "index"), codexDir, claudeDir: join(root, "empty"), backend: "tantivy" });
  await syncAll(app.adapters, app.index, new CursorStore(join(root, "index")));
  app.topology.link({ harness: "codex", sessionId: P }, { harness: "codex", sessionId: C1 });
  app.topology.link({ harness: "codex", sessionId: P }, { harness: "codex", sessionId: C2 });
});

afterAll(() => {
  closeApp(app);
  if (prevState === undefined) delete process.env.CONTEXT_GATEWAY_STATE;
  else process.env.CONTEXT_GATEWAY_STATE = prevState;
});

describe("TopologyStore", () => {
  it("parents/children/siblings resolve", () => {
    expect(app.topology.parentsOf({ harness: "codex", sessionId: C1 })).toEqual([{ harness: "codex", sessionId: P }]);
    expect(app.topology.childrenOf({ harness: "codex", sessionId: P })).toHaveLength(2);
    expect(app.topology.siblingsOf({ harness: "codex", sessionId: C1 })).toEqual([{ harness: "codex", sessionId: C2 }]);
  });

  it("rejects self-links; unlink removes", () => {
    expect(() => app.topology.link({ harness: "codex", sessionId: P }, { harness: "codex", sessionId: P })).toThrow("bad_request");
    expect(app.topology.unlink({ harness: "codex", sessionId: P }, { harness: "codex", sessionId: U })).toBe(false);
  });

  it("auto routing from wording", () => {
    expect(routeAutoScope("what did my parent decide")).toBe("parent");
    expect(routeAutoScope("did any child investigate")).toBe("children");
    expect(routeAutoScope("what did sibling find")).toBe("siblings");
    expect(routeAutoScope("collaboration architecture")).toBe(null);
  });
});

describe("topological search scopes", () => {
  it("children scope searches only linked children", async () => {
    const res = await searchOnce(app, "workbench isolation folly", { scope: "children", callerSessionId: P });
    expect(res.scope).toBe("children");
    const sids = new Set(res.results.map((r) => r.provenance.sessionId));
    expect(sids.has(C1) || sids.has(C2)).toBe(true);
    expect(sids.has(P)).toBe(false);
    expect(sids.has(U)).toBe(false);
  });

  it("parent scope searches only the parent", async () => {
    const res = await searchOnce(app, "workbench isolation folly", { scope: "parent", callerSessionId: C1 });
    expect(res.scope).toBe("parent");
    expect(res.results.length).toBeGreaterThanOrEqual(1);
    for (const r of res.results) expect(r.provenance.sessionId).toBe(P);
  });

  it("siblings scope excludes self and parent", async () => {
    const res = await searchOnce(app, "workbench isolation folly", { scope: "siblings", callerSessionId: C1 });
    expect(res.scope).toBe("siblings");
    expect(res.results.length).toBeGreaterThanOrEqual(1);
    for (const r of res.results) expect(r.provenance.sessionId).toBe(C2);
  });

  it("auto routes parent-hint queries, defaults otherwise", async () => {
    const routed = await searchOnce(app, "what did my parent decide about workbench", { scope: "auto", callerSessionId: C1 });
    expect(routed.scope).toBe("parent");
    for (const r of routed.results) expect(r.provenance.sessionId).toBe(P);
    const plain = await searchOnce(app, "workbench isolation folly", { scope: "auto", callerSessionId: C1 });
    expect(plain.scope).toBe("project");
  });
});
