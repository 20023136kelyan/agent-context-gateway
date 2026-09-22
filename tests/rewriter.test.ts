/**
 * Unit tests for CAsT Conversational Query Rewriting & Multi-Query Expansion.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  cleanPreamble,
  resolveTopologyReferences,
  generateQueryVariants,
  rewriteConversationalQuery,
} from "../src/search/rewriter.js";
import { TopologyStore } from "../src/topology/store.js";

describe("cleanPreamble", () => {
  it("strips conversational filler and preambles", () => {
    expect(cleanPreamble("Can you please find out what we decided about Monaco?")).toBe(
      "we decided about Monaco",
    );
    expect(cleanPreamble("Do you know why the window is sluggish?")).toBe("the window is sluggish");
    expect(cleanPreamble("What did the other agent conclude on the database?")).toBe("the database");
    expect(cleanPreamble("Tell me about the autogit session")).toBe("the autogit session");
  });
});

describe("resolveTopologyReferences", () => {
  let topo: TopologyStore;
  const parentId = "parent-sess-1111";
  const childId = "child-sess-2222";
  const siblingId = "sibling-sess-3333";

  beforeAll(async () => {
    const root = await mkdtemp(join(tmpdir(), "acg-topo-test-"));
    topo = new TopologyStore(join(root, "topology.json"));
    topo.link({ harness: "claude-code", sessionId: parentId }, { harness: "claude-code", sessionId: childId });
    topo.link({ harness: "claude-code", sessionId: parentId }, { harness: "claude-code", sessionId: siblingId });
  });

  it("resolves 'my parent' to the parent session", () => {
    const res = resolveTopologyReferences(
      "What did my parent conclude about Postgres?",
      childId,
      topo,
      "claude-code",
    );
    expect(res.target?.sessionId).toBe(parentId);
    expect(res.cleanedQuery).not.toMatch(/my parent/i);
    expect(res.cleanedQuery).toContain("Postgres");
  });

  it("resolves 'my sibling' to sibling session", () => {
    const res = resolveTopologyReferences(
      "Did my sibling investigate the issue?",
      childId,
      topo,
      "claude-code",
    );
    expect(res.target?.sessionId).toBe(siblingId);
    expect(res.cleanedQuery).not.toMatch(/my sibling/i);
  });

  it("reports which relation it resolved", () => {
    expect(resolveTopologyReferences("What did my parent say?", childId, topo, "claude-code").relation).toBe("parent");
    expect(resolveTopologyReferences("Did my sibling look?", childId, topo, "claude-code").relation).toBe("siblings");
  });

  it("leaves query untouched when no topology reference is present", () => {
    const res = resolveTopologyReferences(
      "Window resizing performance in Electron",
      childId,
      topo,
      "claude-code",
    );
    expect(res.target).toBeUndefined();
    expect(res.cleanedQuery).toBe("Window resizing performance in Electron");
  });
});

describe("generateQueryVariants", () => {
  it("expands action synonyms and technical phrases", () => {
    const { variants, expandedTerms } = generateQueryVariants("replace monaco editor");
    expect(variants.length).toBeGreaterThan(0);
    expect(variants[0]).toMatch(/swap|substitute|migrate/);
    expect(expandedTerms).toContain("swap");
  });

  it("expands multi-word synonyms like 'jointly edit' to 'collaboration'", () => {
    const { variants, expandedTerms } = generateQueryVariants("how to jointly edit code");
    expect(variants.some((v) => v.includes("collaboration"))).toBe(true);
    expect(expandedTerms).toContain("collaboration");
  });
});

describe("rewriteConversationalQuery end-to-end", () => {
  it("produces clean primary query and variants", () => {
    const rewritten = rewriteConversationalQuery("Can you search and find why we decided to replace Monaco?");
    expect(rewritten.primaryQuery).not.toMatch(/can you search and find/i);
    expect(rewritten.primaryQuery).toContain("replace Monaco");
    expect(rewritten.variants.length).toBeGreaterThan(0);
  });
});

describe("prototype-pollution guard", () => {
  it("survives query words that resolve via Object.prototype", () => {
    // Real SWE-Gym query: "_constructor" strips to "constructor", which is a
    // truthy function on Object.prototype — spreading it crashed retrieval.
    const { primary, variants } = generateQueryVariants("BUG: call to _constructor of Series drops timezone");
    expect(primary).toContain("call to _constructor");
    expect(Array.isArray(variants)).toBe(true);
  });
});
