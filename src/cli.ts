#!/usr/bin/env node
/** CLI transport — `gateway <command>`. Human/debug interface; agents use MCP/HTTP. */
import { rerankDefaultOn } from "./search/reranker.js";
import { Command } from "commander";
import { join } from "node:path";
import { createApp, closeApp, type GatewayApp } from "./app.js";
import { dumpConfig } from "./settings.js";
import { listSources, listSessions, searchOnce, decideOnce, getRelated, traverseArtifacts, listInvalidations, listAclRules, setAclRule, removeAclRule, searchLive, getLineage, listSubscriptions, createSubscription, recordFeedback, getSession, getTurn, syncNow, syncSession, backfillEmbeddings, linkSessions, unlinkSessions, showTopology, health } from "./commands.js";
import { addRemote, removeRemote, loadRemotes } from "./remotes.js";
import { readServeInfo, probeServer, remoteCall, connectHost, HttpError } from "./remote.js";

const program = new Command();
program.name("gateway").description("Agent Context Gateway — federated search over native agent histories");
program.option("--index-dir <dir>", "index directory (default ~/.context-gateway/index-tantivy)");
program.option("--backend <name>", "tantivy (default) or sqlite");
program.option("--state-dir <dir>", "base for derived state (default CONTEXT_GATEWAY_STATE or ~/.context-gateway)");
program.option("--json", "JSON output (default for search)", false);

function appFromGlobals() {
  const opts = program.opts();
  // Undefined values fall through to resolveSettings (env, then settings.json,
  // then default), so the CLI no longer hard-codes a backend over them.
  return createApp({ indexDir: opts.indexDir, backend: opts.backend, stateDir: opts.stateDir });
}

function print(data: unknown, forceJson: boolean) {
  if (forceJson || program.opts().json) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log(JSON.stringify(data, null, 2));
  }
}

/**
 * P2a delegation: when `serve` is live, commands run against it over loopback
 * instead of opening a second Tantivy writer (LockBusy otherwise).
 * Returns the remote payload, or null when no server is up (use local app).
 */
async function fetchRemote(method: string, path: string, body?: unknown): Promise<unknown | null> {
  // Any global that changes app identity must be here, or an explicit local
  // configuration silently delegates to a server running a different one.
  if (program.opts().indexDir || program.opts().backend || program.opts().stateDir) return null; // explicit local
  const info = readServeInfo();
  if (!info) return null;
  const host = connectHost(info.host);
  if (!(await probeServer(info.port, 800, host))) return null; // stale port file -> local
  try {
    return await remoteCall(info.port, method, path, body, host);
  } catch (e) {
    // Old server without this route -> local fallback has it. Transport
    // failures mean the probe just raced a shutdown -> local too.
    // Anything else (bad_request etc.) is a real answer: propagate.
    if (e instanceof HttpError && (e.status === 0 || e.status === 404)) return null;
    throw e;
  }
}

async function withLocal<T>(fn: (app: GatewayApp) => Promise<T> | T): Promise<T> {
  const app = appFromGlobals();
  try {
    return await fn(app);
  } finally {
    closeApp(app);
  }
}

function qs(params: Record<string, string | undefined>): string {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) s.set(k, v);
  const str = s.toString();
  return str ? `?${str}` : "";
}

program
  .command("sources")
  .description("List queryable context sources")
  .action(async () => {
    print((await fetchRemote("GET", "/sources")) ?? (await withLocal((app) => listSources(app))), false);
  });

program
  .command("sessions")
  .description("List sessions")
  .option("--harness <harness>", "claude-code | codex | cursor")
  .option("--project <project>", "project slug filter")
  .option("--repo <root>", "git repo root filter")
  .action(async (cmdOpts) => {
    const path = `/sessions${qs({ harness: cmdOpts.harness, project: cmdOpts.project, repo: cmdOpts.repo })}`;
    print((await fetchRemote("GET", path)) ?? (await withLocal((app) => listSessions(app, cmdOpts))), false);
  });

program
  .command("search <query>")
  .description("Search federated agent histories")
  .option("--project <project>")
  .option("--repo <root>", "git repo root filter")
  .option("--harness <harness>")
  .option("--max-results <n>", "", "5")
  .option("--scope <scope>", "project|parent|children|siblings|auto")
  .option("--as-session <id>", "caller session for parent/children/siblings scopes")
  .option("--as-principal <id>", "caller identity for resource-level ACL enforcement")
  .option("--as-of <iso>", "Point-in-time reconstruction (ISO timestamp)")
  .option("--include-superseded", "Include superseded historical knowledge without demotion")
  .option("--no-rerank", "Skip precision reranking (default depends on the selected reranker: on for Jev, off for the local cross-encoder)")
  .action(async (query: string, cmdOpts) => {
    const path = `/search${qs({ q: query, project: cmdOpts.project, repo: cmdOpts.repo, harness: cmdOpts.harness, maxResults: String(cmdOpts.maxResults ?? 5), scope: cmdOpts.scope, callerSessionId: cmdOpts.asSession, principal: cmdOpts.asPrincipal, asOf: cmdOpts.asOf, includeSuperseded: cmdOpts.includeSuperseded ? "true" : undefined, rerank: cmdOpts.rerank === false ? "false" : undefined })}`;
    const res = ((await fetchRemote("GET", path)) ??
      (await withLocal((app) =>
        searchOnce(app, query, {
          project: cmdOpts.project,
          repo: cmdOpts.repo,
          harness: cmdOpts.harness,
          maxResults: Number(cmdOpts.maxResults ?? 5),
          scope: cmdOpts.scope,
          callerSessionId: cmdOpts.asSession,
          callerPrincipal: cmdOpts.asPrincipal,
          asOf: cmdOpts.asOf,
          includeSuperseded: cmdOpts.includeSuperseded ?? false,
          // `--no-rerank` sets this false; otherwise the registry decides per
          // reranker (on for Jev, off for the cross-encoder).
          rerank: cmdOpts.rerank === false ? false : rerankDefaultOn(app.reranker),
        }),
      ))) as Awaited<ReturnType<typeof searchOnce>>;
      if (program.opts().json) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }
      for (const [i, r] of res.results.entries()) {
        console.log(`[${i + 1}] (${r.score.toFixed(3)}) ${r.provenance.harness} / session ${r.provenance.sessionId.slice(0, 8)} / turn ${r.provenance.turnId.split(":").pop()}`);
        console.log(`    ${r.summary.split("\n").join("\n    ")}`);
        console.log(`    turns ${r.context.length} | ${r.provenance.timestamp}`);
      }
      if (res.results.length === 0) console.log("No results.");
  });

program
  .command("session <harness> <sessionId>")
  .description("Show session metadata")
  .action(async (harness: string, sessionId: string) => {
    print((await fetchRemote("GET", `/sessions/${harness}/${sessionId}`)) ?? (await withLocal((app) => getSession(app, harness, sessionId))), false);
  });

program
  .command("turn <harness> <sessionId> <turnId>")
  .description("Show a single turn (direct retrieval)")
  .action(async (harness: string, sessionId: string, turnId: string) => {
    const path = `/sessions/${harness}/${sessionId}/turns/${encodeURIComponent(turnId)}`;
    print((await fetchRemote("GET", path)) ?? (await withLocal((app) => getTurn(app, harness, sessionId, turnId))), false);
  });

program
  .command("sync")
  .description("Incrementally index native histories")
  .option("--rebuild", "wipe disposable index and rebuild from truth")
  .option("--embed", "also backfill turn embeddings (resumable, needs ollama)")
  .action(async (cmdOpts) => {
    const path = `/sync${qs({ rebuild: cmdOpts.rebuild ? "true" : undefined, embed: cmdOpts.embed ? "true" : undefined })}`;
    print((await fetchRemote("POST", path)) ?? (await withLocal((app) => syncNow(app, cmdOpts.rebuild ?? false, { embed: cmdOpts.embed ?? false }))), false);
  });

program
  .command("sync-session <harness> <sessionId>")
  .description("Sync one session now (for SessionEnd hooks: fast, no full scan)")
  .option("--embed", "also embed the session's new turns")
  .option("--parent <ref>", 'declare lineage "harness:sessionId" at sync time')
  .action(async (harness: string, sessionId: string, cmdOpts) => {
    const path = `/sessions/${harness}/${sessionId}/sync${qs({ embed: cmdOpts.embed ? "true" : undefined, parent: cmdOpts.parent })}`;
    try {
      print((await fetchRemote("POST", path)) ?? (await withLocal((app) => syncSession(app, harness, sessionId, { embed: cmdOpts.embed ?? false, parent: cmdOpts.parent }))), false);
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exitCode = 1;
    }
  });

program
  .command("backfill")
  .description("Systematically backfill dense vector embeddings (engine: GATEWAY_EMBED_ENGINE or first available)")
  .option("--batch <n>", "batch size per GPU forward pass", "64")
  .option("--max-sessions <n>", "max sessions to backfill in this run")
  .action(async (cmdOpts) => {
    const res = (await fetchRemote("POST", `/backfill${qs({ batch: cmdOpts.batch, maxSessions: cmdOpts.maxSessions })}`)) ??
      (await withLocal(async (app) => {
        const { resolveEmbeddingEngine } = await import("./indexing/embed-sync.js");
        const engine = await resolveEmbeddingEngine().catch(() => null);
        console.error(`Starting embedding backfill${engine ? ` (${engine})` : ""}...`);
        return backfillEmbeddings(app, {
          batchSize: cmdOpts.batch ? Number(cmdOpts.batch) : 64,
          maxSessions: cmdOpts.maxSessions ? Number(cmdOpts.maxSessions) : undefined,
          onProgress: (p) => {
            console.error(
              `[backfill] ${p.sessionsScanned}/${p.totalSessions} sessions | embedded: ${p.turnsEmbedded} | skipped: ${p.turnsSkipped} | session: ${p.currentSessionId?.slice(0, 8)}`,
            );
          },
        });
      }));
    print(res, false);
  });

program
  .command("topology-link <parentHarness> <parentSession> <childHarness> <childSession>")
  .description("Record a parent→child session link")
  .action(async (ph: string, ps: string, ch: string, cs: string) => {
    print((await fetchRemote("POST", `/topology/link${qs({ ph, ps, ch, cs })}`)) ?? (await withLocal((app) => linkSessions(app, ph, ps, ch, cs))), false);
  });

program
  .command("topology-unlink <parentHarness> <parentSession> <childHarness> <childSession>")
  .description("Remove a parent→child session link")
  .action(async (ph: string, ps: string, ch: string, cs: string) => {
    print((await fetchRemote("POST", `/topology/unlink${qs({ ph, ps, ch, cs })}`)) ?? (await withLocal((app) => unlinkSessions(app, ph, ps, ch, cs))), false);
  });

program
  .command("topology-show")
  .description("Show recorded session links")
  .option("--harness <harness>")
  .option("--session <id>")
  .action(async (cmdOpts) => {
    const path = `/topology${qs({ harness: cmdOpts.harness, sessionId: cmdOpts.session })}`;
    print((await fetchRemote("GET", path)) ?? (await withLocal((app) => showTopology(app, { harness: cmdOpts.harness, sessionId: cmdOpts.session }))), false);
  });

program
  .command("decide <query>")
  .description("Extract decisions + rationale + alternatives (why-questions)")
  .option("--project <project>")
  .option("--repo <root>")
  .option("--harness <harness>")
  .option("--max-decisions <n>", "", "3")
  .action(async (query: string, cmdOpts) => {
    const path = `/decide${qs({ q: query, project: cmdOpts.project, repo: cmdOpts.repo, harness: cmdOpts.harness, maxDecisions: String(cmdOpts.maxDecisions ?? 3) })}`;
    const res = ((await fetchRemote("GET", path)) ??
      (await withLocal((app) =>
        decideOnce(app, query, {
          project: cmdOpts.project,
          repo: cmdOpts.repo,
          harness: cmdOpts.harness,
          maxDecisions: Number(cmdOpts.maxDecisions ?? 3),
        }),
      ))) as Awaited<ReturnType<typeof decideOnce>>;
    if (program.opts().json) {
      console.log(JSON.stringify(res, null, 2));
      return;
    }
    for (const [i, d] of res.decisions.entries()) {
      console.log(`[${i + 1}] (${d.method}, conf ${d.confidence.toFixed(2)}) ${d.session.harness} / ${d.session.sessionId.slice(0, 8)}`);
      console.log(`    concluded: ${d.conclusion.content.split("\n")[0].slice(0, 160)}`);
      for (const r of d.rationale.slice(0, 2)) console.log(`    because: ${r.content.split("\n")[0].slice(0, 140)}`);
      for (const a of d.alternatives.slice(0, 2)) console.log(`    vs: ${a.content.split("\n")[0].slice(0, 140)}`);
    }
    if (res.decisions.length === 0) console.log("No decisions detected — try search for the discussion.");
  });

program
  .command("related <artifact>")
  .description("Artifacts co-occurring with this file/PR/commit across sessions")
  .option("--limit <n>", "", "10")
  .action(async (artifact: string, cmdOpts) => {
    const path = `/related${qs({ artifact, limit: String(cmdOpts.limit ?? 10) })}`;
    print((await fetchRemote("GET", path)) ?? (await withLocal((app) => getRelated(app, artifact, Number(cmdOpts.limit ?? 10)))), false);
  });

program
  .command("graph <artifact>")
  .description("Multi-hop BFS traversal of artifact co-occurrence graph")
  .option("--depth <n>", "", "2")
  .action(async (artifact: string, cmdOpts) => {
    const path = `/artifacts/graph${qs({ artifact, maxDepth: String(cmdOpts.depth ?? 2) })}`;
    print((await fetchRemote("GET", path)) ?? (await withLocal((app) => traverseArtifacts(app, artifact, Number(cmdOpts.depth ?? 2)))), false);
  });

program
  .command("feedback <turnId>")
  .description("Mark a turn helpful (or not) to tune future ranking")
  .option("--helpful", "this result helped")
  .option("--not", "this result did not help")
  .option("--note <text>")
  .action(async (turnId: string, cmdOpts) => {
    const helpful = cmdOpts.helpful ? true : cmdOpts.not ? false : undefined;
    if (helpful === undefined) {
      console.error("pass --helpful or --not");
      process.exitCode = 1;
      return;
    }
    const path = `/feedback${qs({ turnId, helpful: String(helpful), note: cmdOpts.note })}`;
    print((await fetchRemote("POST", path)) ?? (await withLocal((app) => recordFeedback(app, turnId, helpful, cmdOpts.note))), false);
  });

program
  .command("invalidations")
  .description("List bi-temporal invalidation records")
  .action(async () => {
    print((await fetchRemote("GET", "/temporal/invalidations")) ?? (await withLocal((app) => listInvalidations(app))), false);
  });

program
  .command("acl-list")
  .description("List resource-level ACL rules (Phase C.2)")
  .action(async () => {
    print((await fetchRemote("GET", "/acl/rules")) ?? (await withLocal((app) => listAclRules(app))), false);
  });

program
  .command("acl-set <principal>")
  .description("Set resource-level access rule for a caller identity")
  .option("--allow-projects <slugs>", "comma-separated project slugs")
  .option("--allow-harnesses <names>", "comma-separated harnesses")
  .option("--allow-repos <roots>", "comma-separated repo roots")
  .option("--deny-sessions <ids>", "comma-separated session ids to deny")
  .action(async (principal: string, cmdOpts) => {
    const rule = {
      principal,
      allowedProjects: cmdOpts.allowProjects ? cmdOpts.allowProjects.split(",") : undefined,
      allowedHarnesses: cmdOpts.allowHarnesses ? cmdOpts.allowHarnesses.split(",") : undefined,
      allowedRepos: cmdOpts.allowRepos ? cmdOpts.allowRepos.split(",") : undefined,
      deniedSessions: cmdOpts.denySessions ? cmdOpts.denySessions.split(",") : undefined,
    };
    print((await fetchRemote("POST", "/acl/rules", rule)) ?? (await withLocal((app) => setAclRule(app, rule))), false);
  });

program
  .command("acl-remove <principal>")
  .description("Remove an ACL rule for a principal")
  .action(async (principal: string) => {
    print((await fetchRemote("DELETE", `/acl/rules/${principal}`)) ?? (await withLocal((app) => removeAclRule(app, principal))), false);
  });

program
  .command("git-hooks <action>")
  .description("Install git repository hooks to auto-index commits and branches (action: install)")
  .option("--repo <path>", "path to git repository root (defaults to cwd)")
  .action(async (action: string, cmdOpts) => {
    if (action !== "install") {
      console.error(`unknown git-hooks action: "${action}" (supported: install)`);
      process.exitCode = 1;
      return;
    }
    const { installGitHooks } = await import("./git/hooks.js");
    const repoPath = cmdOpts.repo ? (await import("node:path")).resolve(cmdOpts.repo) : process.cwd();
    print(installGitHooks(repoPath), false);
  });

program
  .command("remotes-list")
  .description("List configured remote gateways")
  .action(() => {
    print(loadRemotes().map(({ token, ...r }) => r), false);
  });

program
  .command("remotes-add <name> <url>")
  .description("Add a read-only remote gateway (token stored with 0600 perms)")
  .option("--token <token>")
  .action((name: string, url: string, cmdOpts) => {
    print(addRemote({ name, url, token: cmdOpts.token }), false);
  });

program
  .command("remotes-remove <name>")
  .description("Remove a remote gateway")
  .action((name: string) => {
    print({ removed: removeRemote(name) }, false);
  });

program
  .command("remotes-discover")
  .description("Browse LAN for gateways via mDNS (never auto-adds)")
  .option("--timeout <ms>", "", "5000")
  .option("--add", "add discovered gateways as tokenless remotes")
  .action(async (cmdOpts) => {
    const { discover } = await import("./discovery/mdns.js");
    const found = await discover(Number(cmdOpts.timeout ?? 5000));
    if (cmdOpts.add) {
      for (const f of found) addRemote({ name: f.name, url: `http://${f.host}:${f.port}` });
    }
    print(found, false);
  });

program
  .command("live <query>")
  .description("Search active/running sessions directly from native history (spec §67)")
  .option("--minutes <n>", "activity window in minutes", "15")
  .action(async (query: string, cmdOpts) => {
    const ms = Number(cmdOpts.minutes ?? 15) * 60 * 1000;
    const path = `/live${qs({ q: query, windowMs: String(ms) })}`;
    print((await fetchRemote("GET", path)) ?? (await withLocal((app) => searchLive(app, query, { activeWindowMs: ms }))), false);
  });

program
  .command("lineage <harness> <sessionId>")
  .description("Explore full agent ancestry, descendants, and siblings tree (spec §65)")
  .action(async (harness: string, sessionId: string) => {
    const path = `/topology/lineage${qs({ harness, session: sessionId })}`;
    print((await fetchRemote("GET", path)) ?? (await withLocal((app) => getLineage(app, harness, sessionId))), false);
  });

program
  .command("subscribe <query>")
  .description("Register a context subscription to receive notifications on new turns (spec §66)")
  .option("--harness <harness>")
  .option("--webhook <url>")
  .action(async (query: string, cmdOpts) => {
    const body = { query, harness: cmdOpts.harness, webhookUrl: cmdOpts.webhook };
    print((await fetchRemote("POST", "/subscriptions", body)) ?? (await withLocal((app) => createSubscription(app, query, cmdOpts))), false);
  });

program
  .command("subscriptions")
  .description("List active context subscriptions")
  .action(async () => {
    print((await fetchRemote("GET", "/subscriptions")) ?? (await withLocal((app) => listSubscriptions(app))), false);
  });

program
  .command("serve")
  .description("Start the HTTP API (loopback by default)")
  .option("--port <n>", "", "3000")
  .option("--host <addr>", "bind address; anything but loopback requires GATEWAY_TOKEN", "127.0.0.1")
  .option("--watch", "watch native histories and re-sync on change")
  .option("--embed", "with --watch: also embed new turns")
  .option("--announce", "broadcast on LAN via mDNS (needs a non-loopback --host; off by default for privacy)")
  .action(async (cmdOpts) => {
    const { serveProduction, isLoopbackHost } = await import("./transports/http.js");
    const host = String(cmdOpts.host ?? "127.0.0.1");
    const port = Number(cmdOpts.port ?? 3000);
    if (!isLoopbackHost(host) && !process.env.GATEWAY_TOKEN) {
      console.error(`refusing to bind ${host}: that exposes agent histories to the network. Set GATEWAY_TOKEN first.`);
      process.exitCode = 1;
      return;
    }
    if (cmdOpts.announce && isLoopbackHost(host)) {
      console.error("--announce needs --host <LAN address or 0.0.0.0>: a loopback-bound gateway can't be reached from the LAN.");
      process.exitCode = 1;
      return;
    }
    const app = appFromGlobals();
    let watchers: { close(): void }[] = [];
    if (cmdOpts.watch) {
      const { watchSources } = await import("./watch.js");
      if (cmdOpts.embed) {
        const { initVectors } = await import("./app.js");
        await initVectors(app).catch((e) => console.error("vectors unavailable:", e instanceof Error ? e.message : e));
      }
      watchers = watchSources(app, {
        embed: cmdOpts.embed ?? false,
        onSync: (r) => console.error(`watch sync: ${r.sessionsIndexed} sessions, ${r.turnsIndexed} turns${r.embedded ? `, ${r.embedded} embedded` : ""}`),
        onError: (e) => console.error("watch error:", e instanceof Error ? e.message : e),
      });
      console.error(`watching native histories${cmdOpts.embed ? " (+embed)" : ""}`);
    }
    const server = await serveProduction(app, port, host);
    console.error(`gateway http on http://${host}:${port}`);
    let announcer: { stop(): void } | null = null;
    if (cmdOpts.announce) {
      const { announce } = await import("./discovery/mdns.js");
      announcer = announce(port, { backend: app.backend, docCount: app.index.docCount(), host });
      console.error("announcing _context-gateway._tcp on LAN (opt-in; clients need GATEWAY_TOKEN)");
    }
    const shutdown = async () => {
      announcer?.stop();
      for (const w of watchers) w.close();
      await server.close();
      closeApp(app);
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });

program
  .command("mcp")
  .description("Start MCP server on stdio")
  .action(async () => {
    const { runMcp } = await import("./transports/mcp.js");
    const app = appFromGlobals();
    await runMcp(app);
  });

program
  .command("health")
  .description("Index status, source availability, last sync")
  .action(async () => {
    print((await fetchRemote("GET", "/health")) ?? (await withLocal((app) => health(app))), false);
  });

program
  .command("init")
  .description("First-run onboarding: detect histories, set keys, sync, backfill, hooks, verify")
  .option("--yes", "accept defaults, prompt only for missing API keys")
  .option("--no-hooks", "skip the Claude SessionEnd hook install")
  .option("--no-backfill", "skip vector backfill (lexical index only)")
  .option("--no-verify", "skip the end-to-end smoke search")
  .action(async (cmdOpts) => {
    const { createInterface } = await import("node:readline");
    const { detectHistories, keyStatus, appendEnvKeys, installClaudeHook } = await import("./setup.js");
    const ask = (q: string): Promise<string> =>
      new Promise((res) => {
        if (cmdOpts.yes) return res("");
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        rl.question(q, (a) => {
          rl.close();
          res(a.trim());
        });
      });
    const report: Record<string, unknown> = { steps: [] as string[] };
    const done = (s: string) => (report.steps as string[]).push(s);

    // 1. Histories.
    const sources = detectHistories();
    const found = sources.filter((s) => s.present);
    print({ histories: sources }, false);
    if (found.length === 0) {
      console.error("No agent histories found — sync would index nothing. Point a harness at this machine first.");
      process.exitCode = 1;
      return;
    }
    done(`histories: ${found.map((s) => s.kind).join(", ")}`);

    // 2. Keys (append-only; existing values never shown or overwritten).
    const envPath = join(process.cwd(), ".env");
    const keys = keyStatus();
    const missing = Object.entries(keys)
      .filter(([, v]) => !v)
      .map(([k]) => k);
    const fresh: Record<string, string> = {};
    for (const k of missing) {
      const v = await ask(`${k} (empty = skip, lexical-only for its path): `);
      if (v) fresh[k] = v;
    }
    const added = appendEnvKeys(envPath, fresh);
    // Reload what we just wrote so this process resolves engines correctly.
    for (const k of added) process.env[k] = fresh[k];

    // Telemetry: explicit opt-in, default No. Aggregates only, never content.
    const { setTelemetry } = await import("./settings.js");
    const tel = await ask("Share anonymous usage aggregates to improve the engine? (yes/no, default no): ");
    if (/^(yes|y|on|1)$/i.test(tel)) {
      setTelemetry(undefined, true);
      done("telemetry: on (aggregates only)");
    } else {
      done("telemetry: off (default; `gateway telemetry on` anytime)");
    }
    done(`keys: present=[${Object.entries({ ...keys, ...Object.fromEntries(added.map((k) => [k, true])) }).filter(([, v]) => v).map(([k]) => k).join(", ")}] added=[${added.join(", ")}]`);

    // 3-4. Sync + backfill.
    const synced = await withLocal((app) => syncNow(app, false, {}));
    done(`sync: ${JSON.stringify(synced)}`);
    if (cmdOpts.backfill) {
      const filled = await withLocal((app) => backfillEmbeddings(app, {}));
      done(`backfill: ${JSON.stringify(filled)}`);
    } else {
      done("backfill: skipped");
    }

    // 5. SessionEnd hook.
    if (cmdOpts.hooks) {
      const cliPath = join(process.cwd(), "src", "cli.ts");
      const hook = installClaudeHook(undefined, cliPath);
      done(`hook: ${hook.installed ? `installed${hook.backupPath ? ` (backup ${hook.backupPath})` : ""}` : "already present"}`);
    } else {
      done("hook: skipped");
    }

    // 6. Verify: sources answer.
    if (cmdOpts.verify) {
      const check = await withLocal(async (app) => ({
        sources: (await listSources(app)).length,
        sessions: (await listSessions(app, {})).length,
        models: (await import("./components.js")).lockedStack(),
      }));
      done(`verify: ${JSON.stringify(check)}`);
    } else {
      done("verify: skipped");
    }
    print(report, false);
  });

program
  .command("doctor")
  .description("Diagnose setup: histories, keys, index, vectors, models")
  .action(async () => {
    const { detectHistories, keyStatus } = await import("./setup.js");
    const { lockedStack } = await import("./components.js");
    const report = await withLocal(async (app) => {
      const h = await health(app);
      return {
        histories: detectHistories(),
        keys: keyStatus(),
        health: h,
        vectors: app.vectors ? { backend: app.vectorBackend } : null,
        locked: lockedStack(),
      };
    });
    print(report, false);
  });

program
  .command("stats")
  .description("Usage aggregates: per-arm latency, harness mix, zero-hit rate (shape only, never content)")
  .action(async () => {
    const { aggregateUsage, defaultUsagePath } = await import("./observability/usage.js");
    print(aggregateUsage(defaultUsagePath()), false);
  });

program
  .command("telemetry <action>")
  .description("Anonymous aggregate telemetry: status | on | off (default off; aggregates only, never queries or content)")
  .action(async (action: string) => {
    const { setTelemetry, defaultStateDir } = await import("./settings.js");
    const { buildReport, flushReport } = await import("./observability/report.js");
    if (action === "status") {
      const { resolveSettings } = await import("./settings.js");
      print({ telemetry: resolveSettings().telemetry, sends: "aggregates only (counts, buckets, percentiles)" }, false);
      return;
    }
    if (action === "on" || action === "off") {
      setTelemetry(undefined, action === "on");
      print({ telemetry: action === "on" }, false);
      if (action === "on") {
        // Immediate first flush proves the path works while the user watches.
        const ok = await withLocal(async (app) => {
          const report = buildReport(defaultStateDir(), {
            backend: app.backend,
            engine: app.vectors ? app.vectorBackend : null,
            reranker: app.reranker,
            judge: null,
          });
          return flushReport(report);
        }).catch(() => false);
        console.error(ok ? "first report delivered" : "first report failed (will retry on next flush; nothing breaks)");
      }
      return;
    }
    console.error(`unknown telemetry action "${action}" (want status|on|off)`);
    process.exitCode = 1;
  });

program
  .command("config")
  .description("Show effective tunable values (env > settings.json > defaults)")
  .action(() => {
    print(dumpConfig(), false);
  });

/** Attach availability to a component row without fighting literal types.
 *  Keyed components report key presence; keyless ones report the live probe
 *  (an MLX row on Linux must read false even though nothing is "missing"). */
function withKey(row: Record<string, unknown>, available: Record<string, boolean>): Record<string, unknown> {
  const keyEnv = typeof row.keyEnv === "string" ? row.keyEnv : null;
  const name = typeof row.name === "string" ? row.name : "";
  return { ...row, keyPresent: keyEnv ? (available[name] ?? false) : (available[name] ?? true) };
}

program
  .command("models")
  .description("Swappable pipeline components, availability, and resolved defaults")
  .action(async () => {
    const { ENGINE_DEFS, RERANKER_DEFS, JUDGE_DEFS, lockedStack } = await import("./components.js");
    const { resolveEngine } = await import("./embeddings/provider.js");
    const { resolveRerankerName } = await import("./search/reranker.js");
    const { resolveJudgeName } = await import("./decisions/select.js");
    // Live availability per engine (side-effect free probes).
    const { getProvider } = await import("./embeddings/provider.js");
    const { ENGINES } = await import("./embeddings/provider.js");
    const available: Record<string, boolean> = { jev: Boolean(process.env.TYPESAFE_API_KEY || process.env.JEV_API_KEY) };
    for (const name of ENGINES) {
      try {
        available[name] = await getProvider(name).isAvailable();
      } catch {
        available[name] = false;
      }
    }
    print(
      {
        locked: lockedStack(),
        resolved: {
          engine: await resolveEngine().catch(() => "none"),
          reranker: resolveRerankerName(),
          judge: resolveJudgeName(),
        },
        engines: ENGINE_DEFS.map((e) => withKey(e, available)),
        rerankers: RERANKER_DEFS.map((r) => withKey(r, available)),
        judges: JUDGE_DEFS.map((j) => withKey(j, available)),
      },
      false,
    );
  });

await program.parseAsync(process.argv);
