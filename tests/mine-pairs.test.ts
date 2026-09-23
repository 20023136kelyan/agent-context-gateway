/**
 * Real-history pair mining (scripts/mine-pairs.ts), against a synthetic corpus
 * written in the native Claude Code and Codex formats.
 *
 * The corpus is built to contain every way a label can go wrong: same paths in
 * another project, an earlier session whose edits come too late, a resumed
 * session, a session that only touches boilerplate, and the same repo checked
 * out on another machine under another harness.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeSessions, codexSessions, minePairs, type MinedQuery } from "../scripts/mine-pairs.js";
import { ClaudeAdapter } from "../src/adapters/claude.js";
import { CodexAdapter } from "../src/adapters/codex.js";
import { createApp, closeApp } from "../src/app.js";
import { runEval } from "../src/eval/runner.js";

const ALICE = "/Users/alice/proj/app";

let root: string;
let claudeDir: string;
let codexDir: string;

/** One Claude Code session file: an opening request, then assistant edits. */
function claudeSession(slug: string, id: string, cwd: string, request: string, start: string, edits: [string, string][]) {
  const dir = join(claudeDir, slug);
  mkdirSync(dir, { recursive: true });
  const lines: object[] = [
    { type: "user", uuid: `${id}-u`, sessionId: id, cwd, timestamp: start, message: { role: "user", content: request } },
    ...edits.map(([file, ts], i) => ({
      type: "assistant",
      uuid: `${id}-a${i}`,
      sessionId: id,
      cwd,
      timestamp: ts,
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Editing." },
          { type: "tool_use", id: `tu${i}`, name: i % 2 ? "Write" : "Edit", input: { file_path: file, old_string: "a", new_string: "b" } },
        ],
      },
    })),
  ];
  writeFileSync(join(dir, `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "acg-mine-"));
  claudeDir = join(root, "claude");
  codexDir = join(root, "codex");
  const slug = "-Users-alice-proj-app";

  // A: the original work.
  claudeSession(slug, "sess-a", ALICE, "Add rate limiting to the api client please", "2026-09-01T10:00:00.000Z", [
    [`${ALICE}/src/api/client.ts`, "2026-09-01T10:05:00.000Z"],
    [`${ALICE}/src/api/limits.ts`, "2026-09-01T10:06:00.000Z"],
    [`${ALICE}/package.json`, "2026-09-01T10:07:00.000Z"],
    ["/Users/alice/.claude/projects/-Users-alice-proj-app/memory/MEMORY.md", "2026-09-01T10:08:00.000Z"],
    [`${ALICE}/.claude/launch.json`, "2026-09-01T10:09:00.000Z"],
  ]);
  // Late: started before B, but its edits land after B began, so B cannot find them.
  claudeSession(slug, "sess-late", ALICE, "Refactor the api client for streaming", "2026-09-04T09:00:00.000Z", [
    [`${ALICE}/src/api/client.ts`, "2026-09-05T13:00:00.000Z"],
    [`${ALICE}/src/api/limits.ts`, "2026-09-05T13:01:00.000Z"],
  ]);
  // B: the query. It goes on to edit what A and C already touched.
  claudeSession(slug, "sess-b", ALICE, "The api client keeps getting 429s, fix the retries", "2026-09-05T12:00:00.000Z", [
    [`${ALICE}/src/api/client.ts`, "2026-09-05T12:10:00.000Z"],
    [`${ALICE}/src/api/limits.ts`, "2026-09-05T12:11:00.000Z"],
    [`${ALICE}/src/api/retry.ts`, "2026-09-05T12:12:00.000Z"],
  ]);
  // Resumed session: not a fresh request, skipped by default.
  claudeSession(slug, "sess-cont", ALICE, "This session is being continued from a previous conversation.", "2026-09-06T08:00:00.000Z", [
    [`${ALICE}/src/api/client.ts`, "2026-09-06T08:01:00.000Z"],
    [`${ALICE}/src/api/limits.ts`, "2026-09-06T08:02:00.000Z"],
  ]);
  // Boilerplate only: no specific edits, so never a query.
  claudeSession(slug, "sess-boiler", ALICE, "Bump the dependencies to latest", "2026-09-07T08:00:00.000Z", [
    [`${ALICE}/package.json`, "2026-09-07T08:01:00.000Z"],
    ["/Users/alice/.claude/projects/-Users-alice-proj-app/memory/MEMORY.md", "2026-09-07T08:02:00.000Z"],
    [`${ALICE}/.claude/launch.json`, "2026-09-07T08:03:00.000Z"],
  ]);
  // Same relative paths in ANOTHER project: must never pair with app sessions.
  claudeSession("-Users-alice-proj-other", "sess-other", "/Users/alice/proj/other", "Add rate limiting in the other service", "2026-08-30T10:00:00.000Z", [
    ["/Users/alice/proj/other/src/api/client.ts", "2026-08-30T10:01:00.000Z"],
    ["/Users/alice/proj/other/src/api/limits.ts", "2026-08-30T10:02:00.000Z"],
  ]);

  // C: Codex, same repo on another machine, second-precision timestamps.
  const day = join(codexDir, "2026", "09", "03");
  mkdirSync(day, { recursive: true });
  const codex = [
    { timestamp: "2026-09-03T09:00:00Z", type: "session_meta", payload: { id: "codex-c", cwd: "/home/bob/work/app", timestamp: "2026-09-03T09:00:00Z" } },
    { timestamp: "2026-09-03T09:00:01Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>cwd</environment_context>" }] } },
    { timestamp: "2026-09-03T09:00:02Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "# Files mentioned by the user:\n\n## shot.png: /tmp/shot.png\n\n## My request for Codex:\nImplement a token bucket in client.ts for the api" }] } },
    {
      timestamp: "2026-09-03T09:10:00Z",
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        name: "apply_patch",
        input: "*** Begin Patch\n*** Update File: src/api/client.ts\n@@\n-a\n+b\n*** Add File: /home/bob/work/app/src/api/limits.ts\n+x\n*** End Patch",
      },
    },
  ];
  writeFileSync(join(day, "rollout-2026-09-03T09-00-00-codex-c.jsonl"), codex.map((l) => JSON.stringify(l)).join("\n") + "\n");
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("minePairs", () => {
  let golden: MinedQuery[];
  let continuationsSkipped: number;
  beforeAll(() => {
    ({ golden, continuationsSkipped } = minePairs([...claudeSessions(claudeDir), ...codexSessions(codexDir)]));
  });

  const byQuerySession = (id: string) => golden.find((g) => g.mined.querySession === id);

  it("pairs a query with every earlier session that already edited its files, across harnesses", () => {
    const b = byQuerySession("sess-b");
    expect(b).toBeDefined();
    expect(new Set(b!.relevantSessionIds)).toEqual(new Set(["sess-a", "codex-c"]));
    expect(b!.mined.crossHarness).toBe(true);
  });

  it("cuts the corpus off just before the query session started", () => {
    expect(byQuerySession("sess-b")!.asOf).toBe("2026-09-05T11:59:59.999Z");
  });

  it("never pairs across projects, even on identical relative paths", () => {
    for (const g of golden) expect(g.relevantSessionIds).not.toContain("sess-other");
  });

  it("ignores edits made after the query session began", () => {
    expect(byQuerySession("sess-b")!.relevantSessionIds).not.toContain("sess-late");
  });

  it("normalises timestamps, so second- and millisecond-precision harnesses compare correctly", () => {
    // As raw strings "…:00Z" sorts after "…:00.500Z" in the same second.
    expect(codexSessions(codexDir)[0].start).toBe("2026-09-03T09:00:00.000Z");
  });

  it("matches a repo checked out on another machine, under another harness", () => {
    const c = byQuerySession("codex-c");
    expect(c?.relevantSessionIds).toEqual(["sess-a"]);
    expect(c?.mined.namesSharedFile).toBe(true); // "client.ts" is in the request
    expect(byQuerySession("sess-b")!.mined.namesSharedFile).toBe(false);
  });

  it("takes the request out of a Codex attachment wrapper", () => {
    expect(byQuerySession("codex-c")!.query).toBe("Implement a token bucket in client.ts for the api");
  });

  it("recognises the pasted-files wrapper variant too", async () => {
    const { claudeSessions: _c, ...m } = await import("../scripts/mine-pairs.js");
    const dir = join(root, "codex-pasted", "2026", "09", "08");
    mkdirSync(dir, { recursive: true });
    const text = '# Files pasted by the user:\n\n## "Meeting notes…": /tmp/a.txt\n\n## My request:\nAdd the notes to the portfolio page';
    writeFileSync(
      join(dir, "rollout-p.jsonl"),
      [
        { timestamp: "2026-09-08T09:00:00Z", type: "session_meta", payload: { id: "codex-p", cwd: "/x/app" } },
        { timestamp: "2026-09-08T09:00:01Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } },
      ].map((l) => JSON.stringify(l)).join("\n"),
    );
    expect(m.codexSessions(join(root, "codex-pasted"))[0].query).toBe("Add the notes to the portfolio page");
  });

  it("does not count harness bookkeeping (.claude memory, launch config) as shared work", () => {
    // sess-boiler shares MEMORY.md and launch.json with A; that alone must not pair them.
    expect(byQuerySession("sess-boiler")).toBeUndefined();
  });

  it("skips resumed sessions and boilerplate-only sessions as queries", () => {
    expect(continuationsSkipped).toBe(1);
    expect(byQuerySession("sess-cont")).toBeUndefined();
    expect(byQuerySession("sess-boiler")).toBeUndefined();
  });

  it("uses the same session ids the adapters report, so hits can count", async () => {
    const ids = new Set([
      ...(await new ClaudeAdapter(claudeDir).listSessions()).map((s) => s.id),
      ...(await new CodexAdapter(codexDir).listSessions()).map((s) => s.id),
    ]);
    for (const g of golden) {
      expect(ids.has(g.mined.querySession)).toBe(true);
      for (const id of g.relevantSessionIds) expect(ids.has(id)).toBe(true);
    }
  });

  it("records the project each query was asked from", () => {
    expect(byQuerySession("sess-b")!.project).toBe("app");
    expect(byQuerySession("codex-c")!.project).toBe("app");
  });

  it("evaluates end to end: each query sees only history from before it began", async () => {
    const state = join(root, "state");
    const saved = process.env.CONTEXT_GATEWAY_STATE;
    process.env.CONTEXT_GATEWAY_STATE = state;
    const dead = (n: string) => {
      const d = join(root, n);
      mkdirSync(d, { recursive: true });
      return d;
    };
    const app = createApp({
      claudeDir,
      codexDir,
      indexDir: join(root, "index"),
      cursorDb: dead("empty-cursor"),
      zepDir: dead("empty-zep"),
      opencodeDb: dead("empty-opencode"),
      trajectoryDir: dead("empty-traj"),
      gitRepos: [],
    });
    try {
      const run = await runEval(app, golden, "lexical");
      for (const r of run.queryResults) {
        const q = golden.find((g) => g.id === r.id)!;
        expect(r.topSessionIds).not.toContain(q.mined.querySession);
      }
      expect(run.queryResults.find((r) => r.id === byQuerySession("sess-b")!.id)!.mrr5).toBeGreaterThan(0);

      // Project scope matches across harnesses: "app" is a Claude slug on one
      // machine and a Codex cwd on another, and "other" shares its file paths.
      const { searchOnce } = await import("../src/commands.js");
      const scoped = await searchOnce(app, "rate limiting api client", { project: "app", semantic: false, maxResults: 10 });
      const scopedSessions = new Set(scoped.results.map((r) => r.provenance.sessionId));
      expect(scopedSessions.has("sess-other")).toBe(false);
      expect(scopedSessions.has("sess-a")).toBe(true);
      const global = await searchOnce(app, "rate limiting api client", { semantic: false, maxResults: 10 });
      expect(new Set(global.results.map((r) => r.provenance.sessionId)).has("sess-other")).toBe(true);
      const byCodexName = await searchOnce(app, "token bucket", { project: "APP", semantic: false, maxResults: 10 });
      expect(byCodexName.results.map((r) => r.provenance.sessionId)).toContain("codex-c");
      const nowhere = await searchOnce(app, "rate limiting", { project: "no-such-project", semantic: false });
      expect(nowhere.results).toEqual([]);

      // Soft scope keeps other projects reachable, but in-project hits are boosted.
      const preferred = await searchOnce(app, "rate limiting api client", { preferProject: "app", semantic: false, maxResults: 10 });
      const order = preferred.results.map((r) => r.provenance.sessionId);
      expect(order).toContain("sess-other");
      expect(order.indexOf("sess-a")).toBeLessThan(order.indexOf("sess-other"));

      // The caller's project is the default scope, echoed back; '*' widens it.
      const byDefault = await searchOnce(app, "rate limiting api client", { defaultProject: "app", semantic: false, maxResults: 10 });
      expect(byDefault.projectScope).toEqual({ project: "app", source: "caller" });
      expect(byDefault.results.map((r) => r.provenance.sessionId)).not.toContain("sess-other");
      const widened = await searchOnce(app, "rate limiting api client", { project: "*", defaultProject: "app", semantic: false, maxResults: 10 });
      expect(widened.projectScope.source).toBe("all");
      expect(widened.results.map((r) => r.provenance.sessionId)).toContain("sess-other");

      const filtered = await runEval(app, golden, "lexical", { projectScope: "filter" });
      for (const r of filtered.queryResults) {
        expect(r.topSessionIds.every((id) => id !== "sess-other")).toBe(true);
      }
    } finally {
      closeApp(app);
      if (saved === undefined) delete process.env.CONTEXT_GATEWAY_STATE;
      else process.env.CONTEXT_GATEWAY_STATE = saved;
    }
  });
});
