/**
 * Query facets (roadmap 11c): a long prompt is also searched as its files,
 * pasted errors, identifiers and opening sentence.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { queryFacets } from "../src/search/facets.js";
import { createApp, closeApp, type GatewayApp } from "../src/app.js";
import { syncNow, searchOnce } from "../src/commands.js";

const PROMPT = [
  "The billing page in the website still doesnt show the right plan the user is in.",
  "I am on the mac plan with a trial but it keeps showing free, and the settings drawer",
  "also flickers when I switch accounts. Check src/routes/settings.ts and getUserPlan, here is the error:",
  "TypeError: Cannot read properties of undefined (reading 'planId') at getUserPlan (convex.ts:42)",
].join("\n");

describe("queryFacets", () => {
  it("cuts a long prompt into files, errors, identifiers and its opening sentence", () => {
    const f = Object.fromEntries(queryFacets(PROMPT).map((x) => [x.kind, x.text]));
    expect(f.files).toBe("settings.ts convex.ts"); // convex.ts comes from the pasted stack line
    expect(f.errors).toBe("TypeError: Cannot read properties of undefined (reading 'planId') at getUserPlan (convex.ts:42)");
    expect(f.identifiers?.split(" ")).toEqual(expect.arrayContaining(["getUserPlan", "planId"]));
    expect(f.opening).toBe("The billing page in the website still doesnt show the right plan the user is in.");
  });

  it("prose that runs into pasted output keeps only the output", () => {
    const oneLine = `${"the importer stopped working after the upgrade and I tried a few things, ".repeat(2)}it says RangeError: Maximum call stack size exceeded at walk (tree.ts:9)`;
    expect(queryFacets(oneLine).find((x) => x.kind === "errors")?.text).toBe("RangeError: Maximum call stack size exceeded at walk (tree.ts:9)");
  });

  it("prose about an error is not an error line", () => {
    const f = queryFacets(`${"please look again at why the export keeps failing, ".repeat(3)}I think the error is in the encoder but I am not sure at all`);
    expect(f.find((x) => x.kind === "errors")).toBeUndefined();
  });

  it("short prompts are already one facet", () => {
    expect(queryFacets("fix the login redirect loop in auth.ts")).toEqual([]);
  });
});

describe("search with facets", () => {
  let root: string;
  let app: GatewayApp;
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "acg-facets-"));
    const dir = join(root, "claude", "-Users-alice-app");
    mkdirSync(dir, { recursive: true });
    const session = (id: string, text: string) =>
      writeFileSync(
        join(dir, `${id}.jsonl`),
        JSON.stringify({ type: "user", uuid: `u-${id}`, sessionId: id, cwd: "/Users/alice/app", timestamp: "2026-09-01T10:00:00Z", message: { role: "user", content: text } }),
      );
    // The earlier session that met the same error, in few words.
    session("target", "getUserPlan throws TypeError reading planId when the subscription is missing");
    // Sessions that share the prompt's prose, not its problem.
    for (let i = 0; i < 12; i++) session(`noise${i}`, `the billing page shows the plan the user is in on the website, settings drawer and accounts ${i}`);
    const dead = (n: string) => {
      const d = join(root, n);
      mkdirSync(d, { recursive: true });
      return d;
    };
    app = createApp({
      stateDir: join(root, "state"), claudeDir: join(root, "claude"), codexDir: dead("codex"), indexDir: join(root, "index"), backend: "sqlite",
      cursorDb: dead("cursor"), zepDir: dead("zep"), opencodeDb: dead("opencode"), trajectoryDir: dead("traj"), gitRepos: [],
    });
    await syncNow(app);
  });
  afterAll(() => {
    closeApp(app);
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  const rankOfTarget = async (facets?: boolean) => {
    const res = await searchOnce(app, PROMPT, { project: "*", semantic: false, rerank: false, maxResults: 10, facets });
    return res.results.findIndex((r) => r.provenance.sessionId === "target") + 1;
  };

  it("the pasted error lifts the session that met it", async () => {
    const without = await rankOfTarget(false);
    const withFacets = await rankOfTarget(true);
    expect(withFacets).toBeGreaterThan(0);
    expect(without === 0 || withFacets < without).toBe(true);
  });

  it("is off by default, and settings turn it on", async () => {
    expect(app.settings.facets).toBe(false);
    expect(await rankOfTarget()).toBe(await rankOfTarget(false));
    app.search.setFacets(true);
    try {
      expect(await rankOfTarget()).toBe(await rankOfTarget(true));
    } finally {
      app.search.setFacets(false);
    }
  });
});
