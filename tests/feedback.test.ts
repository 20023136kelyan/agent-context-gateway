/** P3 feedback tests — helpful marks reorder near-tie results. */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FeedbackStore } from "../src/feedback/store.js";
import { createApp, type GatewayApp } from "../src/app.js";
import { searchOnce, recordFeedback } from "../src/commands.js";
import { syncAll } from "../src/indexing/sync.js";
import { CursorStore } from "../src/indexing/store.js";

let app: GatewayApp;
let prevState: string | undefined;
const A = "aaaaaaaa-1111-1111-1111-111111111111";
const B = "bbbbbbbb-2222-2222-2222-222222222222";

beforeAll(async () => {
  prevState = process.env.CONTEXT_GATEWAY_STATE;
  const root = await mkdtemp(join(tmpdir(), "acg-fb-"));
  process.env.CONTEXT_GATEWAY_STATE = join(root, "state");
  const claudeDir = join(root, "claude");
  await mkdir(join(claudeDir, "s"), { recursive: true });
  // Identical content in two sessions -> tied base scores, feedback decides.
  for (const [id, extra] of [[A, "alpha"], [B, "alpha"]] as const) {
    await writeFile(
      join(claudeDir, "s", `${id}.jsonl`),
      JSON.stringify({ type: "user", uuid: "u1", timestamp: "2026-09-10T10:00:00Z", sessionId: id, cwd: "/repo/cozea", message: { role: "user", content: `Zebracorn migration ${extra} notes` } }),
    );
  }
  app = createApp({ indexDir: join(root, "index"), claudeDir, codexDir: join(root, "empty"), backend: "tantivy", cursorDb: join(root, "nope.vscdb") });
  await syncAll(app.adapters, app.index, new CursorStore(join(root, "index")));
});

afterAll(() => {
  if (prevState === undefined) delete process.env.CONTEXT_GATEWAY_STATE;
  else process.env.CONTEXT_GATEWAY_STATE = prevState;
});

describe("FeedbackStore", () => {
  it("latest mark wins; deltas +0.15/-0.30", () => {
    const store = new FeedbackStore(join(tmpdir(), `fb-${Date.now()}.jsonl`));
    expect(store.delta("x")).toBe(0);
    store.record("x", true);
    expect(store.delta("x")).toBe(0.15);
    store.record("x", false);
    expect(store.delta("x")).toBe(-0.3);
    expect(store.size()).toBe(1);
  });
});

describe("feedback ranking", () => {
  it("helpful mark lifts a tied turn to top", async () => {
    const before = await searchOnce(app, "zebracorn migration alpha");
    expect(before.results.length).toBeGreaterThanOrEqual(2);
    const bTurn = before.results.map((r) => r.provenance.turnId).find((id) => id.includes(B))!;
    recordFeedback(app, bTurn, true, "test");
    const after = await searchOnce(app, "zebracorn migration alpha");
    expect(after.results[0].provenance.turnId).toBe(bTurn);
  });

  it("malformed turnId rejected", () => {
    expect(() => recordFeedback(app, "nope", true)).toThrow("bad_request");
  });
});
