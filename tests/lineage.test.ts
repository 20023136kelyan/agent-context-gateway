/**
 * Unit & Integration tests for Agent Lineage Explorer (Phase F).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TopologyStore } from "../src/topology/store.js";
import { exploreLineage } from "../src/topology/lineage.js";

describe("Agent Lineage Explorer", () => {
  let topology: TopologyStore;

  const ROOT = "root-agent-0000";
  const PARENT = "parent-agent-1111";
  const CHILD_A = "child-agent-2222";
  const CHILD_B = "child-agent-3333";
  const SUB_CHILD = "sub-child-agent-4444";

  beforeAll(async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "acg-lineage-"));
    topology = new TopologyStore(join(rootDir, "topology.json"));

    // Topology tree:
    // ROOT -> PARENT -> [CHILD_A -> SUB_CHILD, CHILD_B]
    topology.link({ harness: "claude-code", sessionId: ROOT }, { harness: "claude-code", sessionId: PARENT });
    topology.link({ harness: "claude-code", sessionId: PARENT }, { harness: "claude-code", sessionId: CHILD_A });
    topology.link({ harness: "claude-code", sessionId: PARENT }, { harness: "claude-code", sessionId: CHILD_B });
    topology.link({ harness: "claude-code", sessionId: CHILD_A }, { harness: "claude-code", sessionId: SUB_CHILD });
  });

  it("computes full ancestor chain up to root", () => {
    const report = exploreLineage(topology, { harness: "claude-code", sessionId: CHILD_A });
    expect(report.root.sessionId).toBe(ROOT);
    expect(report.ancestors.map((a) => a.sessionId)).toEqual([PARENT, ROOT]);
  });

  it("identifies sibling agents", () => {
    const report = exploreLineage(topology, { harness: "claude-code", sessionId: CHILD_A });
    expect(report.siblings.map((s) => s.sessionId)).toEqual([CHILD_B]);
  });

  it("recursively traverses descendant subagents", () => {
    const report = exploreLineage(topology, { harness: "claude-code", sessionId: PARENT });
    expect(report.descendants.length).toBe(2);
    const childANode = report.descendants.find((d) => d.session.sessionId === CHILD_A);
    expect(childANode).toBeDefined();
    expect(childANode?.children.map((c) => c.session.sessionId)).toEqual([SUB_CHILD]);
  });

  it("reports total connected network count accurately", () => {
    const report = exploreLineage(topology, { harness: "claude-code", sessionId: CHILD_A });
    expect(report.totalConnectedSessions).toBe(5);
  });
});
