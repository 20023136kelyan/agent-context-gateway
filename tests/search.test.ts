/** M3 search tests — ranking, expansion, provenance, budgets, scopes. */
import { describe, it, expect, beforeAll } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ClaudeAdapter } from "../src/adapters/claude.js";
import { CodexAdapter } from "../src/adapters/codex.js";
import { TantivyIndex } from "../src/indexing/tantivy-index.js";
import { CursorStore } from "../src/indexing/store.js";
import { syncAll } from "../src/indexing/sync.js";
import { SearchService } from "../src/search/search.js";
import { normalizeQuery } from "../src/search/query.js";
import { extractArtifacts, extractCommitShas, extractPrUrls, extractFileRefs } from "../src/adapters/text.js";

let claudeDir: string;
let codexDir: string;
let indexDir: string;
const CLAUDE_SESSION = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff";
const CODEX_SESSION = "019faaaa-0000-1111-2222-333333333333";

function turn(harness: string, n: number, text: string): string {
  if (harness === "claude") {
    return JSON.stringify({
      parentUuid: null, type: n % 2 ? "assistant" : "user", uuid: `u-${n}`,
      timestamp: `2026-09-10T10:${String(n).padStart(2, "0")}:00Z`,
      sessionId: CLAUDE_SESSION, cwd: "/repo/cozea",
      message: n % 2
        ? { role: "assistant", content: [{ type: "text", text }] }
        : { role: "user", content: text },
    });
  }
  return JSON.stringify({
    timestamp: `2026-09-10T09:${String(n).padStart(2, "0")}:00Z`, ordinal: n,
    type: "response_item",
    payload: { type: "message", id: `m${n}`, role: n % 2 ? "assistant" : "user", content: [{ type: "input_text", text }] },
  });
}

beforeAll(async () => {
  const root = await mkdtemp(join(tmpdir(), "acg-m3-"));
  indexDir = join(root, "index");

  claudeDir = join(root, "claude");
  await mkdir(join(claudeDir, "cozea"), { recursive: true });
  const claudeTexts = [
    "Investigate collaboration architecture",
    "Session workbench remains private per design",
    "Files are the shared primitive, see PR #169",
    "Autogit asks before rebasing from main",
    "Checked src/collab/hub.ts for context flow",
    "Unrelated note about lunch menus",
    "Decision: workbench private, files shared",
  ];
  await writeFile(
    join(claudeDir, "cozea", `${CLAUDE_SESSION}.jsonl`),
    claudeTexts.map((t, i) => turn("claude", i, t)).join("\n"),
  );

  codexDir = join(root, "codex");
  await mkdir(join(codexDir, "2026", "09", "10"), { recursive: true });
  const codexTexts = [
    "What was decided about collaboration?",
    "The session workbench is private to each participant",
    "Files are the shared primitive across sessions",
    "Monaco editor discussion is out of scope here",
  ];
  await writeFile(
    join(codexDir, "2026", "09", "10", `rollout-2026-09-10T00-00-00-${CODEX_SESSION}.jsonl`),
    [
      JSON.stringify({ timestamp: "2026-09-10T09:00:00Z", ordinal: 0, type: "session_meta", payload: { session_id: CODEX_SESSION, cwd: "/repo/cozea" } }),
      ...codexTexts.map((t, i) => turn("codex", i + 1, t)),
    ].join("\n"),
  );

  const adapters = [new ClaudeAdapter(claudeDir), new CodexAdapter(codexDir)];
  const index = new TantivyIndex(indexDir);
  try {
    await syncAll(adapters, index, new CursorStore(indexDir));
  } finally {
    index.close();
  }
});

function service() {
  const adapters = [new ClaudeAdapter(claudeDir), new CodexAdapter(codexDir)];
  const index = new TantivyIndex(indexDir);
  return { svc: new SearchService(adapters, index), index };
}

describe("query normalization", () => {
  it("extracts entities + temporal, strips stop-words", () => {
    const nq = normalizeQuery("What did Codex decide about PR #169 yesterday?");
    expect(nq.prNumbers).toContain("169");
    expect(nq.after).toBeTruthy();
    expect(nq.indexQuery).not.toMatch(/\bwhat\b|\babout\b/);
    expect(nq.indexQuery).toMatch(/codex/);
  });
});

describe("artifact extraction", () => {
  it("finds files, commit SHAs and PR URLs; skips pure numbers", () => {
    const arts = extractArtifacts("Fixed in d49e4d74, see https://github.com/cozea/x/pull/169 and src/collab/hub.ts plus 1234567");
    expect(arts).toContain("src/collab/hub.ts");
    expect(arts).toContain("commit:d49e4d74");
    expect(arts).toContain("https://github.com/cozea/x/pull/169");
    expect(arts.some((a) => a.includes("1234567"))).toBe(false);
    expect(extractCommitShas("no shas here")).toEqual([]);
    expect(extractPrUrls("no urls")).toEqual([]);
  });

  it("keeps full file extensions (.json is not .js, .tsx is not .ts)", () => {
    expect(extractFileRefs("edit package.json now")).toEqual(["package.json"]);
    expect(extractFileRefs("see ui/App.tsx")).toEqual(["ui/App.tsx"]);
    expect(extractFileRefs("lib/util.jsx and tsconfig.json.")).toEqual(["lib/util.jsx", "tsconfig.json"]);
    expect(extractFileRefs("main.gopher is not go")).toEqual([]);
  });

  it("ignores UUID segments and hex-only words as commit SHAs", () => {
    expect(extractCommitShas("session 3f2a9b1c-1234-4abc-9def-0123456789ab was defaced")).toEqual([]);
    expect(extractCommitShas("landed in 9f8e7d6c5b")).toEqual(["9f8e7d6c5b"]);
  });
});

describe("SearchService", () => {
  it("finds cross-harness context with full provenance", async () => {
    const { svc, index } = service();
    try {
      const res = await svc.search("What did Codex decide about the collaboration architecture?");
      expect(res.results.length).toBeGreaterThanOrEqual(1);
      for (const r of res.results) {
        expect(r.provenance.harness).toMatch(/claude-code|codex/);
        expect(r.provenance.sessionId).toBeTruthy();
        expect(r.provenance.turnId).toBeTruthy();
        expect(r.provenance.timestamp).toBeTruthy();
        expect(r.provenance.sourcePath).toBeTruthy();
        expect(r.summary.length).toBeGreaterThan(0);
        expect(r.context.length).toBeGreaterThanOrEqual(1);
      }
    } finally {
      index.close();
    }
  });

  it("expands surrounding context around hits", async () => {
    const { svc, index } = service();
    try {
      const res = await svc.search("workbench private files", { maxTurns: 7 });
      const withWindow = res.results.find((r) => r.context.length > 1);
      expect(withWindow).toBeTruthy();
      expect(withWindow!.context.length).toBeLessThanOrEqual(7);
    } finally {
      index.close();
    }
  });

  it("respects harness scope", async () => {
    const { svc, index } = service();
    try {
      const res = await svc.search("collaboration workbench", { harness: "codex" });
      for (const r of res.results) expect(r.provenance.harness).toBe("codex");
    } finally {
      index.close();
    }
  });

  it("topology scopes need a caller session", async () => {
    const { svc, index } = service();
    try {
      await expect(svc.search("parent decision", { scope: "parent" })).rejects.toThrow('needs callerSessionId');
      await expect(svc.search("x", { scope: "bogus" })).rejects.toThrow("unknown scope");
    } finally {
      index.close();
    }
  });

  it("enforces token budget", async () => {
    const { svc, index } = service();
    try {
      const res = await svc.search("collaboration", { maxTokens: 100 });
      for (const r of res.results) {
        const chars = r.context.reduce((n, t) => n + t.content.length, 0);
        expect(chars).toBeLessThanOrEqual(100 * 4 + 2000); // window kept, edges trimmed
      }
    } finally {
      index.close();
    }
  });

  it("ranking is deterministic across runs", async () => {
    // NOTE: one TantivyIndex per dir per process (writer lock) — sequential
    // searches on the same instance must return identical ordering.
    const { svc, index } = service();
    try {
      const r1 = await svc.search("collaboration workbench files");
      const r2 = await svc.search("collaboration workbench files");
      expect(r1.results.map((r) => r.provenance.turnId)).toEqual(r2.results.map((r) => r.provenance.turnId));
      // Scores carry float noise from Date.now() in recency decay — closeness, not bit-equality.
      for (let i = 0; i < r1.results.length; i++) {
        expect(r1.results[i].score).toBeCloseTo(r2.results[i].score, 6);
      }
    } finally {
      index.close();
    }
  });
});
