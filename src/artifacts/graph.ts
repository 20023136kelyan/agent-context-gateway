/**
 * P3 artifact graph — file/PR/commit co-occurrence across sessions.
 * Supports:
 * - 1-hop immediate related artifacts
 * - Multi-hop Breadth-First-Search (BFS) traversal (e.g. file -> session -> PR -> session -> file)
 * No new index: artifact paths already live in turn content (matched
 * lexically) and in stored fileRefs. Derived on demand, never authoritative.
 */
import type { SearchIndex } from "../indexing/types.js";
import { extractArtifacts } from "../adapters/text.js";

export interface RelatedArtifact {
  artifact: string;
  sessions: number;
  sessionIds: string[];
}

export interface GraphNode {
  artifact: string;
  depth: number;
  score: number;
  viaSessions: string[];
}

export interface GraphEdge {
  from: string;
  to: string;
  session: string;
}

export interface GraphTraversalResult {
  origin: string;
  maxDepth: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

function sessionOf(turnId: string): string | null {
  const parts = turnId.split(":");
  return parts.length >= 3 ? `${parts[0]}:${parts[1]}` : null;
}

/** Sessions whose turns mention the artifact (lexical content match). */
export function sessionsForArtifact(index: SearchIndex, artifact: string, limit = 20): string[] {
  const base = artifact.split("/").pop() ?? artifact;
  const hits = index.search(`${artifact} ${base}`, { limit });
  const out: string[] = [];
  for (const h of hits) {
    const s = sessionOf(h.turnId);
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= limit) break;
  }
  return out;
}

export function relatedArtifacts(
  index: SearchIndex,
  artifact: string,
  limit = 10,
): { related: RelatedArtifact[]; sessions: string[] } {
  const sessions = sessionsForArtifact(index, artifact);
  if (sessions.length === 0) return { related: [], sessions };
  // Pull stored docs for hits in those sessions to harvest co-occurring refs.
  const hits = index.search(artifact.split("/").pop() ?? artifact, { limit: 100 });
  const docs = index.getTurnsByIds(hits.map((h) => h.turnId));
  const counts = new Map<string, { n: number; sessions: Set<string> }>();
  for (const d of docs) {
    const key = sessionOf(d.id);
    if (!key || !sessions.includes(key)) continue;
    const refs = new Set([...(d.fileRefs ?? []), ...extractArtifacts(d.content)]);
    refs.delete(artifact);
    for (const r of refs) {
      const e = counts.get(r) ?? { n: 0, sessions: new Set<string>() };
      e.n += 1;
      e.sessions.add(key);
      counts.set(r, e);
    }
  }
  const related = [...counts.entries()]
    .map(([a, e]) => ({ artifact: a, sessions: e.sessions.size, sessionIds: [...e.sessions].slice(0, 5) }))
    .sort((x, y) => y.sessions - x.sessions || y.artifact.localeCompare(x.artifact))
    .slice(0, limit);
  return { related, sessions };
}

/**
 * Multi-hop BFS traversal over the artifact co-occurrence graph.
 * Explores connections up to maxDepth hops (default 2, capped at 3) with distance decay.
 */
export function traverseArtifactGraphBFS(
  index: SearchIndex,
  origin: string,
  maxDepth = 2,
  limitPerHop = 8,
): GraphTraversalResult {
  const boundedDepth = Math.min(3, Math.max(1, maxDepth));
  const queue: { artifact: string; depth: number; pathWeight: number }[] = [
    { artifact: origin, depth: 0, pathWeight: 1.0 },
  ];
  const visited = new Set<string>([origin]);
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  while (queue.length > 0) {
    const curr = queue.shift()!;
    if (curr.depth >= boundedDepth) continue;

    const { related } = relatedArtifacts(index, curr.artifact, limitPerHop);
    for (const rel of related) {
      edges.push({
        from: curr.artifact,
        to: rel.artifact,
        session: rel.sessionIds[0] ?? "unknown",
      });

      if (!visited.has(rel.artifact)) {
        visited.add(rel.artifact);
        const nextDepth = curr.depth + 1;
        const nextWeight = curr.pathWeight * 0.5;
        nodes.push({
          artifact: rel.artifact,
          depth: nextDepth,
          score: Number((rel.sessions * nextWeight).toFixed(3)),
          viaSessions: rel.sessionIds,
        });

        queue.push({
          artifact: rel.artifact,
          depth: nextDepth,
          pathWeight: nextWeight,
        });
      }
    }
  }

  nodes.sort((a, b) => b.score - a.score || a.depth - b.depth);
  return { origin, maxDepth: boundedDepth, nodes, edges };
}
