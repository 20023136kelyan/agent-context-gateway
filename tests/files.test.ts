/**
 * Prompt -> files -> sessions (src/search/files.ts): sessions ranked by the
 * files they edited, and that list fused into search when `files` is on.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { identifierWords, rankSessionsByFiles } from "../src/search/files.js";
import type { EditedFile } from "../src/actions/store.js";
import { createApp, closeApp, type GatewayApp } from "../src/app.js";
import { syncNow, searchOnce } from "../src/commands.js";

describe("identifierWords", () => {
  it("splits paths and prompts into identifier words, dropping generic ones", () => {
    expect(identifierWords("src/components/HowItWorks.tsx")).toEqual(["how", "work"]);
    expect(identifierWords("lib/stripe_webhooks/parseURLPath.ts")).toEqual(["stripe", "webhook", "parse", "url", "path"]);
    expect(identifierWords("Fix the hydration error in HowItWorks")).toEqual(["fix", "the", "hydration", "error", "how", "work"]);
  });
});

describe("rankSessionsByFiles", () => {
  const e = (sessionId: string, rel: string, turnId = `${sessionId}-t`): EditedFile => ({ harness: "claude-code", sessionId, rel, turnId, ts: "2026-09-01T00:00:00Z" });
  const edits = [
    e("s1", "src/components/HowItWorks.tsx", "s1-edit"),
    e("s1", "package.json"),
    e("s2", "src/billing/stripeWebhook.ts"),
    e("s2", "src/billing/invoice.ts"),
    e("s3", "src/components/Header.tsx"),
    e("s4", "README.md"),
  ];

  it("ranks the session whose files the prompt names, with its edit turn", () => {
    const [top, ...rest] = rankSessionsByFiles("the how it works section throws a hydration error", edits);
    expect(top).toMatchObject({ sessionId: "s1", turnId: "s1-edit", files: ["src/components/HowItWorks.tsx"] });
    expect(rest).toEqual([]);
    expect(rankSessionsByFiles("stripe webhook retries", edits)[0]!.sessionId).toBe("s2");
  });

  it("leaves out words most sessions share, and prompts that match nothing", () => {
    const common = [e("a", "src/api/client.ts"), e("b", "src/api/client.ts"), e("c", "src/api/client.ts"), e("d", "src/db.ts")];
    expect(rankSessionsByFiles("the api client", common)).toEqual([]);
    expect(rankSessionsByFiles("deploy to cloudflare", edits)).toEqual([]);
  });
});

describe("search with files on", () => {
  let root: string;
  let app: GatewayApp;
  const line = (o: object) => JSON.stringify(o);
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "acg-files-"));
    const claude = join(root, "claude", "-Users-alice-site");
    mkdirSync(claude, { recursive: true });
    const session = (id: string, day: string, ask: string, file: string, reply: string) =>
      writeFileSync(
        join(claude, `${id}.jsonl`),
        [
          { type: "user", uuid: `${id}-u`, sessionId: id, cwd: "/Users/alice/site", timestamp: `2026-09-${day}T10:00:00Z`, message: { role: "user", content: ask } },
          { type: "assistant", uuid: `${id}-a`, sessionId: id, cwd: "/Users/alice/site", timestamp: `2026-09-${day}T10:01:00Z`, message: { role: "assistant", content: [
            { type: "tool_use", id: `${id}-x`, name: "Edit", input: { file_path: `/Users/alice/site/${file}`, old_string: "a", new_string: "b" } },
          ] } },
          { type: "assistant", uuid: `${id}-r`, sessionId: id, cwd: "/Users/alice/site", timestamp: `2026-09-${day}T10:02:00Z`, message: { role: "assistant", content: reply } },
        ].map(line).join("\n"),
      );
    // The conversation never says "how it works"; only the edited file does.
    session("s1", "01", "the landing page flickers on load, please look", "src/components/HowItWorks.tsx", "Made the section client-only; the flicker is gone.");
    session("s2", "02", "please look at the checkout flow on load", "src/billing/checkout.ts", "Checkout now loads the cart once.");
    const dead = (n: string) => {
      const d = join(root, n);
      mkdirSync(d, { recursive: true });
      return d;
    };
    app = createApp({
      stateDir: join(root, "state"), claudeDir: join(root, "claude"), codexDir: dead("codex"), indexDir: join(root, "index"),
      cursorDb: dead("cursor"), zepDir: dead("zep"), opencodeDb: dead("opencode"), trajectoryDir: dead("traj"), gitRepos: [],
    });
    await syncNow(app);
  });
  afterAll(() => {
    closeApp(app);
    rmSync(root, { recursive: true, force: true });
  });

  it("finds the session that edited the file the prompt names", async () => {
    const q = "HowItWorks hydration error";
    const on = await searchOnce(app, q, { project: "*", semantic: false, rerank: false, files: true });
    expect(on.results[0]!.provenance.sessionId).toBe("s1");
    const off = await searchOnce(app, q, { project: "*", semantic: false, rerank: false, files: false });
    expect(off.results.some((r) => r.provenance.sessionId === "s1")).toBe(false);
  });

  it("respects asOf: files edited later do not count", async () => {
    const res = await searchOnce(app, "HowItWorks hydration", { project: "*", semantic: false, rerank: false, files: true, asOf: "2026-08-30T00:00:00Z" });
    expect(res.results).toEqual([]);
  });
});
