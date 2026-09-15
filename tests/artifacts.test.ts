/** P3 artifact graph tests — co-occurrence and multi-hop BFS across sessions. */
import { describe, it, expect, beforeAll } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ClaudeAdapter } from "../src/adapters/claude.js";
import { TantivyIndex } from "../src/indexing/tantivy-index.js";
import { CursorStore } from "../src/indexing/store.js";
import { syncAll } from "../src/indexing/sync.js";
import { relatedArtifacts, sessionsForArtifact, traverseArtifactGraphBFS } from "../src/artifacts/graph.js";

let index: TantivyIndex;

beforeAll(async () => {
  const root = await mkdtemp(join(tmpdir(), "acg-graph-"));
  const claudeDir = join(root, "claude");
  await mkdir(join(claudeDir, "s"), { recursive: true });
  const sess = (id: string, texts: string[]) =>
    texts
      .map((text, i) =>
        JSON.stringify({ type: "user", uuid: `u-${i}`, timestamp: "2026-09-10T10:00:00Z", sessionId: id, cwd: "/repo/cozea", message: { role: "user", content: text } }),
      )
      .join("\n");
  // Hop 1 connections
  await writeFile(join(claudeDir, "s", "s1.jsonl"), sess("s1", ["Edit src/collab/hub.ts and src/collab/store.ts for sync"]));
  await writeFile(join(claudeDir, "s", "s2.jsonl"), sess("s2", ["Fix src/collab/hub.ts race, see PR #169"]));
  await writeFile(join(claudeDir, "s", "s3.jsonl"), sess("s3", ["Unrelated lunch plans with tacos"]));
  // Hop 2 connection via PR #169 -> docs/collab-plan.md
  await writeFile(join(claudeDir, "s", "s4.jsonl"), sess("s4", ["PR #169 implements docs/collab-plan.md specification"]));

  const adapters = [new ClaudeAdapter(claudeDir)];
  index = new TantivyIndex(join(root, "index"));
  await syncAll(adapters, index, new CursorStore(join(root, "index")));
});

describe("artifact graph", () => {
  it("finds sessions mentioning an artifact", () => {
    const sessions = sessionsForArtifact(index, "src/collab/hub.ts");
    expect(sessions.length).toBeGreaterThanOrEqual(2);
  });

  it("ranks co-occurring artifacts, excludes self and unrelated", () => {
    const { related } = relatedArtifacts(index, "src/collab/hub.ts");
    const names = related.map((r) => r.artifact);
    expect(names).toContain("src/collab/store.ts");
    expect(names).toContain("PR #169");
    expect(names).not.toContain("src/collab/hub.ts");
    const store = related.find((r) => r.artifact === "src/collab/store.ts")!;
    expect(store.sessions).toBeGreaterThanOrEqual(1);
  });

  it("multi-hop BFS traverses from hub.ts -> PR #169 -> docs/collab-plan.md", () => {
    const graph = traverseArtifactGraphBFS(index, "src/collab/hub.ts", 2);
    expect(graph.origin).toBe("src/collab/hub.ts");
    expect(graph.maxDepth).toBe(2);

    const nodeNames = graph.nodes.map((n) => n.artifact);
    // Depth 1
    expect(nodeNames).toContain("PR #169");
    expect(nodeNames).toContain("src/collab/store.ts");
    // Depth 2
    expect(nodeNames).toContain("docs/collab-plan.md");

    const hop2Node = graph.nodes.find((n) => n.artifact === "docs/collab-plan.md");
    expect(hop2Node?.depth).toBe(2);
    expect(hop2Node?.score).toBeGreaterThan(0);
    expect(graph.edges.some((e) => e.to === "docs/collab-plan.md")).toBe(true);
  });

  it("unknown artifacts yield empty graph", () => {
    expect(relatedArtifacts(index, "src/does/not-exist-zzz.ts")).toEqual({ related: [], sessions: [] });
    expect(traverseArtifactGraphBFS(index, "src/does/not-exist-zzz.ts").nodes).toEqual([]);
  });
});
