/**
 * Agent Lineage Explorer (spec §17, §65).
 * Explores full ancestry trees, descendants, siblings, and subagent hierarchies.
 */
import type { TopologyStore, SessionRef, TopologyLink } from "./store.js";

export interface LineageTreeNode {
  session: SessionRef;
  children: LineageTreeNode[];
  depth: number;
}

export interface LineageReport {
  target: SessionRef;
  root: SessionRef;
  ancestors: SessionRef[]; // parent, grandparent, ...
  descendants: LineageTreeNode[];
  siblings: SessionRef[];
  totalConnectedSessions: number;
}

const key = (r: SessionRef) => `${r.harness}:${r.sessionId}`;

export function buildDescendantTree(
  topology: TopologyStore,
  current: SessionRef,
  depth = 0,
  visited = new Set<string>(),
): LineageTreeNode {
  visited.add(key(current));
  const directChildren = topology.childrenOf(current);
  const children: LineageTreeNode[] = [];

  for (const child of directChildren) {
    if (!visited.has(key(child))) {
      children.push(buildDescendantTree(topology, child, depth + 1, visited));
    }
  }

  return { session: current, children, depth };
}

export function exploreLineage(topology: TopologyStore, target: SessionRef): LineageReport {
  const visitedAncestors = new Set<string>();
  const ancestors: SessionRef[] = [];
  let curr = target;

  // 1. Walk upward to find all ancestors and the root parent
  while (true) {
    const parents = topology.parentsOf(curr);
    if (parents.length === 0 || visitedAncestors.has(key(parents[0]))) {
      break;
    }
    const parent = parents[0];
    visitedAncestors.add(key(parent));
    ancestors.push(parent);
    curr = parent;
  }

  const root = ancestors.length > 0 ? ancestors[ancestors.length - 1] : target;

  // 2. Siblings of the target
  const siblings = topology.siblingsOf(target);

  // 3. Descendants tree starting from target
  const tree = buildDescendantTree(topology, target);
  const descendants = tree.children;

  // 4. Count distinct connected sessions
  const allConnected = new Set<string>([key(target), ...ancestors.map(key), ...siblings.map(key)]);
  const countNodes = (n: LineageTreeNode) => {
    allConnected.add(key(n.session));
    for (const c of n.children) countNodes(c);
  };
  for (const d of descendants) countNodes(d);

  return {
    target,
    root,
    ancestors,
    descendants,
    siblings,
    totalConnectedSessions: allConnected.size,
  };
}
