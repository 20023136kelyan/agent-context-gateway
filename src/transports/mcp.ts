/**
 * MCP transport — exposes the gateway to agents via Model Context Protocol.
 * Thin wrappers over commands.ts; same core as CLI/HTTP.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { GatewayApp } from "../app.js";
import { listSources, listSessions, searchOnce, decideOnce, getRelated, traverseArtifacts, listInvalidations, listAclRules, searchLive, getLineage, createSubscription, listSubscriptions, recordFeedback, getSession, getTurn, getContext, showTopology } from "../commands.js";

const Harness = z.enum(["claude-code", "codex", "cursor", "zep", "git"]);

function text(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

export function buildMcpServer(app: GatewayApp): McpServer {
  const server = new McpServer({ name: "agent-context-gateway", version: "0.1.0" });

  server.tool("context.list_sources", "List queryable agent-history sources", {}, async () => text(await listSources(app)));

  server.tool(
    "context.list_sessions",
    "List native agent sessions, optionally filtered",
    { harness: Harness.optional(), project: z.string().optional(), repo: z.string().optional() },
    async (args) => text(await listSessions(app, args)),
  );

  server.tool(
    "context.search",
    "Semantic/lexical search over other agents' native work histories. Returns compact context with provenance.",
    {
      query: z.string().describe("Natural-language question, e.g. 'What did Codex decide about collaboration?'"),
      project: z.string().optional(),
      repo: z.string().optional().describe("Git repo root for precise project scoping"),
      harness: Harness.optional(),
      sessionId: z.string().optional(),
      scope: z.enum(["project", "parent", "children", "siblings", "auto"]).optional(),
      callerSessionId: z.string().optional().describe("This session's id; required for parent/children/siblings scopes"),
      callerPrincipal: z.string().optional().describe("Caller identity for resource-level ACL enforcement"),
      asOf: z.string().optional().describe("Point-in-time reconstruction (ISO timestamp): ignores invalidations after this date"),
      includeSuperseded: z.boolean().optional().describe("Include superseded historical knowledge without demotion"),
      semantic: z.boolean().optional().describe("false = lexical only (skip vector candidates)"),
      rerank: z
        .boolean()
        .default(true)
        .describe("Rerank top candidates for precision. ON by default (NDCG@5 0.699 -> 0.968 on the fixture corpus); pass false to skip it and save ~450ms, or when query text must not leave the machine."),
      maxResults: z.number().min(1).max(20).optional(),
      maxTurns: z.number().min(1).max(15).optional(),
      maxTokens: z.number().min(100).max(20000).optional(),
    },
    async (args) => text(await searchOnce(app, args.query, args)),
  );

  server.tool(
    "context.get_session",
    "Direct session retrieval (authoritative source data)",
    { harness: Harness, sessionId: z.string() },
    async (args) => text(await getSession(app, args.harness, args.sessionId)),
  );

  server.tool(
    "context.get_turn",
    "Direct turn retrieval (authoritative source data)",
    { harness: Harness, sessionId: z.string(), turnId: z.string() },
    async (args) => text(await getTurn(app, args.harness, args.sessionId, args.turnId)),
  );

  server.tool(
    "context.get_context",
    "Expanded evidence window around a turn (±3 by default)",
    { harness: Harness, sessionId: z.string(), turnId: z.string(), window: z.number().min(0).max(10).optional() },
    async (args) => text(await getContext(app, args.harness, args.sessionId, args.turnId, args.window ?? 3)),
  );

  server.tool(
    "context.decide",
    "Why-questions: extract decisions + rationale + alternatives with confidence and source turns. Use for why/reason/decision/choice questions; use context.search for discussion retrieval.",
    {
      query: z.string().describe("Why-question, e.g. 'Why did we reject Monaco?'"),
      project: z.string().optional(),
      repo: z.string().optional(),
      harness: Harness.optional(),
      maxDecisions: z.number().min(1).max(10).optional(),
    },
    async (args) => text(await decideOnce(app, args.query, args)),
  );

  server.tool(
    "context.get_related",
    "Artifacts (files, PRs, commits) that co-occur with this one across sessions",
    { artifact: z.string(), limit: z.number().min(1).max(30).optional() },
    async (args) => text(await getRelated(app, args.artifact, args.limit ?? 10)),
  );

  server.tool(
    "context.traverse_artifacts",
    "Multi-hop BFS traversal over artifact co-occurrence graph (e.g. file -> session -> PR -> session -> file)",
    { artifact: z.string(), maxDepth: z.number().min(1).max(3).optional() },
    async (args) => text(await traverseArtifacts(app, args.artifact, args.maxDepth ?? 2)),
  );

  server.tool(
    "context.feedback",
    "Mark a returned turn helpful (or not) to tune future ranking",
    { turnId: z.string(), helpful: z.boolean(), note: z.string().optional() },
    async (args) => text(recordFeedback(app, args.turnId, args.helpful, args.note)),
  );

  server.tool(
    "context.get_topology",
    "Show recorded parent/child session links (spec §17)",
    { harness: Harness.optional(), sessionId: z.string().optional() },
    async (args) => text(showTopology(app, args)),
  );

  server.tool(
    "context.get_invalidations",
    "Show bi-temporal invalidation records (turns superseded by later decisions)",
    {},
    async () => text(listInvalidations(app)),
  );

  server.tool(
    "context.get_acl_rules",
    "Show resource-level access control rules (Phase C.2)",
    {},
    async () => text(listAclRules(app)),
  );

  server.tool(
    "context.search_live",
    "Query actively running sessions in real-time bypassing the index (spec §67)",
    { query: z.string(), windowMinutes: z.number().optional() },
    async (args) =>
      text(
        await searchLive(app, args.query, {
          activeWindowMs: args.windowMinutes ? args.windowMinutes * 60 * 1000 : undefined,
        }),
      ),
  );

  server.tool(
    "context.explore_lineage",
    "Explore full ancestry tree, descendants, and siblings of an agent session (spec §65)",
    { harness: Harness, sessionId: z.string() },
    async (args) => text(getLineage(app, args.harness, args.sessionId)),
  );

  server.tool(
    "context.subscribe",
    "Register a context subscription to receive notifications when matching turns appear (spec §66)",
    { query: z.string(), harness: Harness.optional(), webhookUrl: z.string().optional() },
    async (args) => text(createSubscription(app, args.query, { harness: args.harness, webhookUrl: args.webhookUrl })),
  );

  server.tool(
    "context.list_subscriptions",
    "List context subscriptions with their most recent matches (poll here when you registered no webhook)",
    {},
    async () => text(listSubscriptions(app)),
  );

  return server;
}

export async function runMcp(app: GatewayApp): Promise<void> {
  const server = buildMcpServer(app);
  await server.connect(new StdioServerTransport());
}
