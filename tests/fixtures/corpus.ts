/**
 * Committed fixture corpus for the evaluation harness.
 *
 * The real golden set (tests/eval/golden.json) names session UUIDs from one
 * developer's private agent history. That makes it unrunnable anywhere else and
 * unshareable with CI — the numbers in tests/eval/baseline.json cannot be
 * reproduced or even attempted on another machine. This corpus replaces it with
 * something synthetic, committed and reproducible (spec §71).
 *
 * It is authored to DISCRIMINATE between retrieval arms, which a naive corpus
 * does not:
 *   - `paraphrase` turns share no content words with their query, so lexical
 *     BM25 cannot find them and only embeddings or a judge can.
 *   - `distractor` turns carry heavy term overlap with a query while answering
 *     nothing, so a lexical-only arm ranks them top. These are what a reranker
 *     has to push down; without them every arm looks equally good.
 *   - decision sessions carry conclusion + rationale + rejected alternative, the
 *     shape `extractDecisions` looks for.
 *
 * Invented project: "Narwhal", a realtime collaborative editor. No real history.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface FixtureTurn {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface FixtureSession {
  /** Stable id — golden queries reference these, so never renumber them. */
  id: string;
  harness: "claude-code" | "codex";
  /** Becomes cwd (Claude) / session_meta.cwd (Codex). */
  project: string;
  startedAt: string;
  turns: FixtureTurn[];
}

const t = (role: FixtureTurn["role"], content: string): FixtureTurn => ({ role, content });

export const FIXTURE_SESSIONS: FixtureSession[] = [
  // ---------------------------------------------------------------- decisions
  {
    id: "f0000001-0000-4000-8000-000000000001",
    harness: "claude-code",
    project: "/repo/narwhal",
    startedAt: "2026-03-01T09:00:00Z",
    turns: [
      t("user", "We need to pick an editor component for the Narwhal client."),
      t("assistant", "The realistic options are Monaco, CodeMirror 6 and Ace. Monaco is what VS Code ships, so it is the most familiar."),
      t("user", "What does Monaco cost us in bundle size?"),
      t("assistant", "Monaco is 2.3MB gzipped and pulls in its own web worker infrastructure, which fights our bundler config. Our entire UI budget is 5MB."),
      t("assistant", "Decision: we rejected Monaco and went with CodeMirror 6. The deciding factor was bundle size against a 5MB budget, plus the worker setup conflicting with our build. Ace was dismissed earlier because its API is dated."),
      t("user", "Fine, CodeMirror it is."),
    ],
  },
  {
    id: "f0000002-0000-4000-8000-000000000002",
    harness: "codex",
    project: "/repo/narwhal",
    startedAt: "2026-03-04T11:00:00Z",
    turns: [
      t("user", "Are we keeping Supabase for auth in Narwhal?"),
      t("assistant", "Supabase covers email and OAuth, but enterprise customers are asking for SAML single sign-on, which Supabase does not offer on our plan."),
      t("assistant", "We decided to move authentication to WorkOS. The reason is the enterprise SSO requirement; Supabase would have meant building SAML ourselves. We considered staying on Supabase and bolting on a SAML proxy, and rejected that as more long-term maintenance."),
      t("user", "What happens to existing sessions during the migration?"),
      t("assistant", "Existing sessions stay valid until expiry; we dual-read tokens for two weeks."),
    ],
  },
  {
    id: "f0000003-0000-4000-8000-000000000003",
    harness: "claude-code",
    project: "/repo/narwhal",
    startedAt: "2026-03-09T14:30:00Z",
    turns: [
      t("user", "The sync layer keeps dropping edits when two people type at once."),
      t("assistant", "That is a classic concurrent-edit conflict. Operational transforms and CRDTs are the two standard answers."),
      t("assistant", "We chose Yjs, a CRDT library, over writing operational transforms by hand. The rationale is that OT needs a central authority to order operations and we want offline edits to merge. We rejected hand-rolled OT because the edge cases around undo are notoriously hard to get right."),
      t("user", "Does Yjs handle presence too?"),
      t("assistant", "Yes, y-protocols ships an awareness channel for cursors and selections."),
    ],
  },

  // ------------------------------------------------------------- paraphrase
  // Deliberately share no content words with their golden queries.
  {
    id: "f0000004-0000-4000-8000-000000000004",
    harness: "codex",
    project: "/repo/narwhal",
    startedAt: "2026-03-12T10:00:00Z",
    turns: [
      t("user", "The page takes forever before anything shows up."),
      t("assistant", "First contentful paint is 4.1 seconds. The bundle ships every locale up front."),
      t("assistant", "Splitting translations into per-language chunks loaded on demand cut first paint to 1.2 seconds. The main thread no longer parses 800KB of strings nobody reads."),
      t("user", "Good. Anything else dragging?"),
      t("assistant", "Fonts were blocking render; preloading the subset fixed the last 300ms."),
    ],
  },
  {
    id: "f0000005-0000-4000-8000-000000000005",
    harness: "claude-code",
    project: "/repo/narwhal",
    startedAt: "2026-03-14T16:00:00Z",
    turns: [
      t("user", "New hires keep breaking the build on their first day."),
      t("assistant", "The setup script assumes a Homebrew Python and silently picks up the system one otherwise."),
      t("assistant", "Pinning the toolchain in a devcontainer removed the whole class of problem. Everyone now gets an identical environment regardless of what is installed on their laptop."),
      t("user", "Does that slow anything down?"),
      t("assistant", "Cold start is about ninety seconds; after that it is indistinguishable from native."),
    ],
  },
  {
    id: "f0000006-0000-4000-8000-000000000006",
    harness: "codex",
    project: "/repo/narwhal",
    startedAt: "2026-03-17T09:30:00Z",
    turns: [
      t("user", "Customers say their documents vanish sometimes."),
      t("assistant", "Reproduced it. When the websocket drops mid-save the client clears its dirty flag before the server has acknowledged the write."),
      t("assistant", "Holding the dirty flag until the server acknowledges, and replaying the buffer on reconnect, stopped the data loss entirely. Nothing is cleared until it is durable."),
      t("user", "Ship it."),
    ],
  },

  // ------------------------------------------------------------------- code
  {
    id: "f0000007-0000-4000-8000-000000000007",
    harness: "claude-code",
    project: "/repo/narwhal",
    startedAt: "2026-03-20T13:00:00Z",
    turns: [
      t("user", "Where does the websocket reconnect backoff live?"),
      t("assistant", "In src/net/reconnect.ts. `backoffMs(attempt)` returns `Math.min(30_000, 250 * 2 ** attempt)` with jitter applied by `withJitter`."),
      t("assistant", "The cap matters: without the 30s ceiling a client offline overnight would wait hours before its next attempt."),
      t("user", "Is the jitter full or equal?"),
      t("assistant", "Equal jitter — half the delay fixed, half random, which avoids a thundering herd when the server restarts."),
    ],
  },
  {
    id: "f0000008-0000-4000-8000-000000000008",
    harness: "codex",
    project: "/repo/narwhal",
    startedAt: "2026-03-22T15:00:00Z",
    turns: [
      t("user", "How is document presence broadcast to other clients?"),
      t("assistant", "`PresenceChannel.publish` in src/collab/presence.ts batches cursor updates on a 50ms timer and sends one frame per tick."),
      t("assistant", "Batching was necessary because a fast typist generated 40 frames a second per client, and with twelve people in a document the server spent more time on presence than on edits."),
      t("user", "What happens when someone goes idle?"),
      t("assistant", "After 60 seconds without input the client stops publishing and peers grey out the cursor."),
    ],
  },
  {
    id: "f0000009-0000-4000-8000-000000000009",
    harness: "claude-code",
    project: "/repo/narwhal",
    startedAt: "2026-03-25T11:15:00Z",
    turns: [
      t("user", "Explain how the snapshot compaction job decides what to delete."),
      t("assistant", "`compactSnapshots` in src/storage/compact.ts keeps every snapshot from the last 24 hours, then one per day for 30 days, then one per month."),
      t("assistant", "It never deletes the newest snapshot for a document even if it falls outside every window, which is the guard that stopped us wiping cold documents last quarter."),
      t("user", "Is it safe to run concurrently?"),
      t("assistant", "It takes a per-document advisory lock, so two workers cannot compact the same document at once."),
    ],
  },

  // ------------------------------------------------------------- distractors
  // High term overlap with the queries above, answering nothing. A lexical-only
  // arm ranks these at the top; pushing them down is the reranker's whole job.
  {
    id: "f0000010-0000-4000-8000-000000000010",
    harness: "claude-code",
    project: "/repo/narwhal",
    startedAt: "2026-03-26T09:00:00Z",
    turns: [
      t("user", "We still need to decide between Monaco, CodeMirror and Ace before the demo."),
      t("assistant", "Agreed, let us put the editor decision on the agenda for Thursday."),
      t("user", "Also we should decide about Supabase versus WorkOS for authentication at some point."),
      t("assistant", "Noted. Both the editor choice and the auth choice are still open items on the planning board."),
      t("user", "And someone should look at whether Yjs or operational transforms make more sense for sync."),
      t("assistant", "I will add CRDT versus OT to the same agenda. No conclusions yet on any of these."),
    ],
  },
  {
    id: "f0000011-0000-4000-8000-000000000011",
    harness: "codex",
    project: "/repo/narwhal",
    startedAt: "2026-03-27T10:00:00Z",
    turns: [
      t("user", "Status update on the websocket reconnect work and the presence batching?"),
      t("assistant", "Both are in review. The reconnect backoff branch and the presence batching branch are waiting on the same reviewer."),
      t("user", "What about snapshot compaction?"),
      t("assistant", "Compaction is unchanged this week. No code moved in src/storage/compact.ts or src/net/reconnect.ts."),
    ],
  },
  {
    id: "f0000012-0000-4000-8000-000000000012",
    harness: "claude-code",
    project: "/repo/other-project",
    startedAt: "2026-03-28T12:00:00Z",
    turns: [
      t("user", "Unrelated project: set up the billing webhook handler."),
      t("assistant", "Stripe webhooks verified with the signing secret, handler in src/billing/webhook.ts."),
      t("user", "Retries?"),
      t("assistant", "Stripe retries for three days with exponential backoff; we make the handler idempotent by event id."),
    ],
  },

  // ------------------------------------------------------- judge duels (1)
  // Paired real-decision + proposal-distractor sessions sharing rare keywords.
  // Both must land in decideOnce's top-3 sessions so the judge has to choose:
  // the distractor carries decision-shaped language (strong cue + speaker) but
  // settles nothing ("settles nothing", "still open", "No conclusions yet").
  // Duel 1: Postgres vs MySQL for the billing ledger.
  {
    id: "f0000013-0000-4000-8000-000000000013",
    harness: "claude-code",
    project: "/repo/narwhal",
    startedAt: "2026-03-29T09:00:00Z",
    turns: [
      t("user", "Billing needs a ledger for invoice charges. Postgres or MySQL — which one do we pick?"),
      t("assistant", "Both handle the ledger workload. MySQL already runs our session storage, so it is the path of least resistance."),
      t("assistant", "Decision: we decided to go with Postgres over MySQL for the billing ledger. The reason is Postgres handles concurrent balance updates with serializable transactions, and the ledger needs that guarantee. We considered staying on MySQL and rejected it because its gap locks caused deadlocks in the last load test."),
      t("user", "Fine, Postgres for the ledger it is."),
    ],
  },
  {
    id: "f0000014-0000-4000-8000-000000000014",
    harness: "codex",
    project: "/repo/narwhal",
    startedAt: "2026-03-30T09:00:00Z",
    turns: [
      t("user", "Billing ledger database: Postgres or MySQL — which one do we pick?"),
      t("assistant", "Final call for the spike: we selected Postgres for the prototype ledger, because queries over the billing rows looked simpler in Postgres. But this settles nothing — the choice between Postgres and MySQL for the billing ledger is still open and we will revisit it after the load test."),
      t("user", "So no conclusion on Postgres versus MySQL for the ledger yet?"),
      t("assistant", "Correct. No conclusions yet on the billing ledger database. Postgres versus MySQL stays undecided until the numbers are in."),
    ],
  },
  // Duel 2: Kafka vs SQS for the event bus.
  {
    id: "f0000015-0000-4000-8000-000000000015",
    harness: "claude-code",
    project: "/repo/narwhal",
    startedAt: "2026-03-31T09:00:00Z",
    turns: [
      t("user", "The event bus drops messages under burst load. Kafka or SQS — which one do we pick?"),
      t("assistant", "SQS is managed and cheap, but per-message latency spikes past 2 seconds during bursts, which breaks cursor sync."),
      t("assistant", "Decision: we decided to go with Kafka over SQS for the event bus. The reason is Kafka keeps ordered offsets per partition, and the bus needs replay after deploys. We considered staying on SQS and rejected it because its at-least-once redelivery duplicated cursor events."),
      t("user", "Kafka for the bus, noted."),
    ],
  },
  {
    id: "f0000016-0000-4000-8000-000000000016",
    harness: "codex",
    project: "/repo/narwhal",
    startedAt: "2026-04-01T09:00:00Z",
    turns: [
      t("user", "Event bus: Kafka or SQS — which one do we pick?"),
      t("assistant", "Final call for the spike: we selected Kafka for the prototype bus, because publishing over the event channel looked simpler in Kafka. But this settles nothing — the choice between Kafka and SQS for the event bus is still open and we will revisit it after the burst test."),
      t("user", "So no conclusion on Kafka versus SQS for the bus yet?"),
      t("assistant", "Correct. No conclusions yet on the event bus. Kafka versus SQS stays undecided until the numbers are in."),
    ],
  },
  // Duel 3: Tailwind vs CSS modules for styling.
  {
    id: "f0000017-0000-4000-8000-000000000017",
    harness: "claude-code",
    project: "/repo/narwhal",
    startedAt: "2026-04-02T09:00:00Z",
    turns: [
      t("user", "Styling is a mess of overrides. Tailwind or CSS modules — which one do we pick?"),
      t("assistant", "CSS modules scope everything, but every variant needs a new class file, and the design tokens drifted across twelve files."),
      t("assistant", "Decision: we decided to go with Tailwind over CSS modules for styling. The reason is Tailwind keeps the design tokens in one config, and styling stays consistent across the app. We considered staying on CSS modules and rejected it because the override chains made reviews miserable."),
      t("user", "Tailwind for styling, done."),
    ],
  },
  {
    id: "f0000018-0000-4000-8000-000000000018",
    harness: "codex",
    project: "/repo/narwhal",
    startedAt: "2026-04-03T09:00:00Z",
    turns: [
      t("user", "Styling approach: Tailwind or CSS modules — which one do we pick?"),
      t("assistant", "Final call for the spike: we selected Tailwind for the prototype styling, because building layouts over the utility classes looked faster in Tailwind. But this settles nothing — the choice between Tailwind and CSS modules for styling is still open and we will revisit it after the redesign."),
      t("user", "So no conclusion on Tailwind versus CSS modules yet?"),
      t("assistant", "Correct. No conclusions yet on styling. Tailwind versus CSS modules stays undecided until the redesign lands."),
    ],
  },
  // Duel 4: Redis vs Memcached for throttle counters.
  {
    id: "f0000019-0000-4000-8000-000000000019",
    harness: "claude-code",
    project: "/repo/narwhal",
    startedAt: "2026-04-04T09:00:00Z",
    turns: [
      t("user", "Throttle counters need atomic increments. Redis or Memcached — which one do we pick?"),
      t("assistant", "Memcached is faster for plain gets, but it cannot run Lua, so the increment-and-expire logic needs two round trips."),
      t("assistant", "Decision: we decided to go with Redis over Memcached for the throttle counters. The reason is Redis runs the increment and expiry in one Lua script, and the throttle path needs that atomicity. We considered staying on Memcached and rejected it because the two-step version raced under load."),
      t("user", "Redis for throttle counters, good."),
    ],
  },
  {
    id: "f0000020-0000-4000-8000-000000000020",
    harness: "codex",
    project: "/repo/narwhal",
    startedAt: "2026-04-05T09:00:00Z",
    turns: [
      t("user", "Throttle counters: Redis or Memcached — which one do we pick?"),
      t("assistant", "Final call for the spike: we selected Redis for the prototype throttle, because counting over the request window looked simpler in Redis. But this settles nothing — the choice between Redis and Memcached for the throttle counters is still open and we will revisit it after the soak test."),
      t("user", "So no conclusion on Redis versus Memcached yet?"),
      t("assistant", "Correct. No conclusions yet on the throttle counters. Redis versus Memcached stays undecided until the soak test finishes."),
    ],
  },
  // Duel 5: gRPC vs tRPC for comment threads.
  {
    id: "f0000021-0000-4000-8000-000000000021",
    harness: "claude-code",
    project: "/repo/narwhal",
    startedAt: "2026-04-06T09:00:00Z",
    turns: [
      t("user", "Comment threads need typed endpoints. gRPC or tRPC — which one do we pick?"),
      t("assistant", "tRPC reuses our TypeScript types for free, but the mobile client cannot speak it, and comments must render on mobile."),
      t("assistant", "Decision: we decided to go with gRPC over tRPC for the comment threads. The reason is gRPC generates clients for every platform, and comment threads ship on mobile next quarter. We considered staying on tRPC and rejected it because hand-writing the mobile layer cost more than the schema setup."),
      t("user", "gRPC for comment threads, understood."),
    ],
  },
  {
    id: "f0000022-0000-4000-8000-000000000022",
    harness: "codex",
    project: "/repo/narwhal",
    startedAt: "2026-04-07T09:00:00Z",
    turns: [
      t("user", "Comment threads transport: gRPC or tRPC — which one do we pick?"),
      t("assistant", "Final call for the spike: we selected gRPC for the prototype comment feed, because fetching over the thread pages looked simpler in gRPC. But this settles nothing — the choice between gRPC and tRPC for the comment threads is still open and we will revisit it after the mobile spike."),
      t("user", "So no conclusion on gRPC versus tRPC yet?"),
      t("assistant", "Correct. No conclusions yet on the comment threads. gRPC versus tRPC stays undecided until the mobile spike lands."),
    ],
  },
  // Duel 6: S3 vs R2 for backup vaults.
  {
    id: "f0000023-0000-4000-8000-000000000023",
    harness: "claude-code",
    project: "/repo/narwhal",
    startedAt: "2026-04-08T09:00:00Z",
    turns: [
      t("user", "Backup vaults need versioned blobs. S3 or R2 — which one do we pick?"),
      t("assistant", "R2 has zero egress fees, but its object versioning is weaker, and vault restores depend on listing old versions."),
      t("assistant", "Decision: we decided to go with S3 over R2 for the backup vaults. The reason is S3 versions every object and lists them reliably, and the vault restore path needs that history. We considered staying on R2 and rejected it because a failed restore drill lost a version last month."),
      t("user", "S3 for the backup vaults, fine."),
    ],
  },
  {
    id: "f0000024-0000-4000-8000-000000000024",
    harness: "codex",
    project: "/repo/narwhal",
    startedAt: "2026-04-09T09:00:00Z",
    turns: [
      t("user", "Backup vault storage: S3 or R2 — which one do we pick?"),
      t("assistant", "Final call for the spike: we selected S3 for the prototype vault, because copying over the backup sets looked simpler in S3. But this settles nothing — the choice between S3 and R2 for the backup vaults is still open and we will revisit it after the restore drill."),
      t("user", "So no conclusion on S3 versus R2 yet?"),
      t("assistant", "Correct. No conclusions yet on the backup vaults. S3 versus R2 stays undecided until the drill finishes."),
    ],
  },
  // Duel 7: Playwright vs Cypress for the e2e suite.
  {
    id: "f0000025-0000-4000-8000-000000000025",
    harness: "claude-code",
    project: "/repo/narwhal",
    startedAt: "2026-04-10T09:00:00Z",
    turns: [
      t("user", "E2E flakes block every release. Playwright or Cypress — which one do we pick?"),
      t("assistant", "Cypress has the nicer dashboard, but it runs inside the browser, so multi-tab collaboration flows cannot be tested at all."),
      t("assistant", "Decision: we decided to go with Playwright over Cypress for the e2e suite. The reason is Playwright drives multiple browser contexts, and the e2e suite covers multi-user editing. We considered staying on Cypress and rejected it because the collaboration specs were all skipped."),
      t("user", "Playwright for e2e, ship it."),
    ],
  },
  {
    id: "f0000026-0000-4000-8000-000000000026",
    harness: "codex",
    project: "/repo/narwhal",
    startedAt: "2026-04-11T09:00:00Z",
    turns: [
      t("user", "E2E framework: Playwright or Cypress — which one do we pick?"),
      t("assistant", "Final call for the spike: we selected Playwright for the prototype e2e run, because running over the smoke specs looked simpler in Playwright. But this settles nothing — the choice between Playwright and Cypress for the e2e suite is still open and we will revisit it after the flake audit."),
      t("user", "So no conclusion on Playwright versus Cypress yet?"),
      t("assistant", "Correct. No conclusions yet on the e2e suite. Playwright versus Cypress stays undecided until the audit finishes."),
    ],
  },
  // Duel 8: pnpm vs npm for workspace installs.
  {
    id: "f0000027-0000-4000-8000-000000000027",
    harness: "claude-code",
    project: "/repo/narwhal",
    startedAt: "2026-04-12T09:00:00Z",
    turns: [
      t("user", "Workspace installs take nine minutes. pnpm or npm — which one do we pick?"),
      t("assistant", "npm is the default everyone knows, but it duplicates the dependency tree per package, which is where the nine minutes go."),
      t("assistant", "Decision: we decided to go with pnpm over npm for the workspace installs. The reason is pnpm links a single content store, and the workspace has forty packages sharing React. We considered staying on npm and rejected it because the install cache kept exceeding the CI disk."),
      t("user", "pnpm for the workspace, fine."),
    ],
  },
  {
    id: "f0000028-0000-4000-8000-000000000028",
    harness: "codex",
    project: "/repo/narwhal",
    startedAt: "2026-04-13T09:00:00Z",
    turns: [
      t("user", "Workspace installs: pnpm or npm — which one do we pick?"),
      t("assistant", "Final call for the spike: we selected pnpm for the prototype workspace, because linking over the shared packages looked simpler in pnpm. But this settles nothing — the choice between pnpm and npm for the workspace installs is still open and we will revisit it after the CI trial."),
      t("user", "So no conclusion on pnpm versus npm yet?"),
      t("assistant", "Correct. No conclusions yet on the workspace installs. pnpm versus npm stays undecided until the trial finishes."),
    ],
  },
  // Duel 9: WebRTC vs HLS for voice comments.
  {
    id: "f0000029-0000-4000-8000-000000000029",
    harness: "claude-code",
    project: "/repo/narwhal",
    startedAt: "2026-04-14T09:00:00Z",
    turns: [
      t("user", "Voice comments need low latency playback. WebRTC or HLS — which one do we pick?"),
      t("assistant", "HLS reuses our CDN pipeline, but segment packaging adds six seconds of delay, which kills conversational replies."),
      t("assistant", "Decision: we decided to go with WebRTC over HLS for the voice comments. The reason is WebRTC delivers sub-second audio, and voice comments feel broken above one second. We considered staying on HLS and rejected it because the delay made every reply sound stale."),
      t("user", "WebRTC for voice comments, agreed."),
    ],
  },
  {
    id: "f0000030-0000-4000-8000-000000000030",
    harness: "codex",
    project: "/repo/narwhal",
    startedAt: "2026-04-15T09:00:00Z",
    turns: [
      t("user", "Voice comments transport: WebRTC or HLS — which one do we pick?"),
      t("assistant", "Final call for the spike: we selected WebRTC for the prototype voice notes, because streaming over the audio track looked simpler in WebRTC. But this settles nothing — the choice between WebRTC and HLS for the voice comments is still open and we will revisit it after the latency trial."),
      t("user", "So no conclusion on WebRTC versus HLS yet?"),
      t("assistant", "Correct. No conclusions yet on the voice comments. WebRTC versus HLS stays undecided until the trial finishes."),
    ],
  },
  // Duel 10: ClickHouse vs Druid for analytics scans.
  {
    id: "f0000031-0000-4000-8000-000000000031",
    harness: "claude-code",
    project: "/repo/narwhal",
    startedAt: "2026-04-16T09:00:00Z",
    turns: [
      t("user", "Analytics queries scan billions of events. ClickHouse or Druid — which one do we pick?"),
      t("assistant", "Druid ingests in real time, but operating the cluster needs a dedicated team, and we have half an SRE."),
      t("assistant", "Decision: we decided to go with ClickHouse over Druid for the analytics scans. The reason is ClickHouse runs as a single binary with excellent compression, and the analytics workload is mostly bulk scans. We considered staying on Druid and rejected it because the ops burden exceeded our capacity."),
      t("user", "ClickHouse for analytics, noted."),
    ],
  },
  {
    id: "f0000032-0000-4000-8000-000000000032",
    harness: "codex",
    project: "/repo/narwhal",
    startedAt: "2026-04-17T09:00:00Z",
    turns: [
      t("user", "Analytics engine: ClickHouse or Druid — which one do we pick?"),
      t("assistant", "Final call for the spike: we selected ClickHouse for the prototype analytics, because scanning over the event samples looked simpler in ClickHouse. But this settles nothing — the choice between ClickHouse and Druid for the analytics scans is still open and we will revisit it after the scale test."),
      t("user", "So no conclusion on ClickHouse versus Druid yet?"),
      t("assistant", "Correct. No conclusions yet on the analytics scans. ClickHouse versus Druid stays undecided until the scale test finishes."),
    ],
  },
  // Duel 11: OAuth vs magic links for trial login.
  {
    id: "f0000033-0000-4000-8000-000000000033",
    harness: "claude-code",
    project: "/repo/narwhal",
    startedAt: "2026-04-18T09:00:00Z",
    turns: [
      t("user", "Login friction kills trial conversion. OAuth or magic links — which one do we pick?"),
      t("assistant", "Magic links need no passwords, but corporate inboxes delay them by minutes, and trial users bounce before clicking."),
      t("assistant", "Decision: we decided to go with OAuth over magic links for the trial login. The reason is OAuth finishes in two redirects, and the login funnel needs that speed. We considered staying on magic links and rejected it because the email delay tanked conversion in the test."),
      t("user", "OAuth for login, fine."),
    ],
  },
  {
    id: "f0000034-0000-4000-8000-000000000034",
    harness: "codex",
    project: "/repo/narwhal",
    startedAt: "2026-04-19T09:00:00Z",
    turns: [
      t("user", "Trial login: OAuth or magic links — which one do we pick?"),
      t("assistant", "Final call for the spike: we selected OAuth for the prototype login, because redirecting over the trial signup looked simpler in OAuth. But this settles nothing — the choice between OAuth and magic links for the trial login is still open and we will revisit it after the conversion test."),
      t("user", "So no conclusion on OAuth versus magic links yet?"),
      t("assistant", "Correct. No conclusions yet on the trial login. OAuth versus magic links stays undecided until the test finishes."),
    ],
  },
  // Duel 12: monorepo vs polyrepo for the repo layout.
  {
    id: "f0000035-0000-4000-8000-000000000035",
    harness: "claude-code",
    project: "/repo/narwhal",
    startedAt: "2026-04-20T09:00:00Z",
    turns: [
      t("user", "Repo layout slows cross-package changes. Monorepo or polyrepo — which one do we pick?"),
      t("assistant", "Polyrepo gives each team independence, but versioning the shared editor core across five repos broke twice this quarter."),
      t("assistant", "Decision: we decided to go with the monorepo over the polyrepo for the repo layout. The reason is the monorepo keeps one version of the editor core, and the layout needs atomic cross-package edits. We considered staying on the polyrepo and rejected it because the version matrix consumed release days."),
      t("user", "Monorepo for the layout, done."),
    ],
  },
  {
    id: "f0000036-0000-4000-8000-000000000036",
    harness: "codex",
    project: "/repo/narwhal",
    startedAt: "2026-04-21T09:00:00Z",
    turns: [
      t("user", "Repo layout: monorepo or polyrepo — which one do we pick?"),
      t("assistant", "Final call for the spike: we selected the monorepo for the prototype layout, because refactoring over the package boundaries looked simpler in the monorepo. But this settles nothing — the choice between the monorepo and the polyrepo for the repo layout is still open and we will revisit it after the migration trial."),
      t("user", "So no conclusion on monorepo versus polyrepo yet?"),
      t("assistant", "Correct. No conclusions yet on the repo layout. Monorepo versus polyrepo stays undecided until the trial finishes."),
    ],
  },

  // --------------------------------------------- standalone decisions (clean)
  // Unique topics with no paired distractor: retrieval should find these
  // directly, so they measure recall rather than judge precision.
  {
    id: "f0000037-0000-4000-8000-000000000037",
    harness: "codex",
    project: "/repo/narwhal",
    startedAt: "2026-04-22T09:00:00Z",
    turns: [
      t("user", "Offline cache must survive restarts. SQLite or IndexedDB — which one do we pick?"),
      t("assistant", "IndexedDB is built into the browser, but its async API complicates the boot sequence, and corruptions are unrecoverable."),
      t("assistant", "We settled on SQLite for the offline cache. The rationale is SQLite gives us a single file with ACID writes, and the cache must survive crashes. We considered IndexedDB and dismissed it as too fragile after the corruption incident."),
      t("user", "SQLite for the cache, good."),
    ],
  },
  {
    id: "f0000038-0000-4000-8000-000000000038",
    harness: "claude-code",
    project: "/repo/narwhal",
    startedAt: "2026-04-23T09:00:00Z",
    turns: [
      t("user", "Form validation needs shared schemas. Zod or Yup — which one do we pick?"),
      t("assistant", "Yup is battle-tested, but its TypeScript inference lags, and the signup schema already drifted from its types."),
      t("assistant", "Final decision: Zod for validation. The reason is Zod infers types directly from the schema, and validation must stay in sync with the code. We weighed Yup as the alternative and rejected it because the manual type mirrors kept rotting."),
      t("user", "Zod it is."),
    ],
  },
  {
    id: "f0000039-0000-4000-8000-000000000039",
    harness: "codex",
    project: "/repo/narwhal",
    startedAt: "2026-04-24T09:00:00Z",
    turns: [
      t("user", "Monitoring bill tripled. Datadog or Grafana — which one do we pick?"),
      t("assistant", "Datadog correlates traces and logs beautifully, but the per-host pricing punishes our autoscaling, which is the whole bill problem."),
      t("assistant", "We agreed to move monitoring to Grafana. The reason is Grafana queries our existing object storage, and monitoring must scale without per-host fees. Staying on Datadog was the alternative we rejected after the pricing review."),
      t("user", "Grafana for monitoring, fine."),
    ],
  },
  {
    id: "f0000040-0000-4000-8000-000000000040",
    harness: "claude-code",
    project: "/repo/narwhal",
    startedAt: "2026-04-25T09:00:00Z",
    turns: [
      t("user", "Rollouts keep breaking staging. Feature flags or long-lived branches — which one do we pick?"),
      t("assistant", "Long-lived branches isolate work, but merging the collaboration rewrite took four days, which is the breakage pattern repeating."),
      t("assistant", "Decision: we are going with feature flags for rollouts. The reason is flags let us disable broken paths in production without a deploy, and rollouts need that escape hatch. We considered branch-based rollouts and rejected them because the merge conflicts scaled with team size."),
      t("user", "Flags for rollouts, agreed."),
    ],
  },
  {
    id: "f0000041-0000-4000-8000-000000000041",
    harness: "codex",
    project: "/repo/narwhal",
    startedAt: "2026-04-26T09:00:00Z",
    turns: [
      t("user", "Test runs take eleven minutes. Vitest or Jest — which one do we pick?"),
      t("assistant", "Jest has the ecosystem, but its transform pipeline re-processes every file, which is where the eleven minutes go."),
      t("assistant", "We locked in Vitest for the test suite. The rationale is Vitest reuses the build pipeline and runs in parallel workers, and the suite needs sub-minute feedback. We kept Jest as the alternative and rejected it after the timing trial showed no path below five minutes."),
      t("user", "Vitest, good."),
    ],
  },
  {
    id: "f0000042-0000-4000-8000-000000000042",
    harness: "claude-code",
    project: "/repo/narwhal",
    startedAt: "2026-04-27T09:00:00Z",
    turns: [
      t("user", "Offset pagination skips rows on large tables. Keyset or offset — which one do we pick?"),
      t("assistant", "Offset is simple to implement, but inserting rows shifts every page, which is exactly the skipping bug customers reported."),
      t("assistant", "Decision: keyset pagination it is. The reason is keyset anchors on the last seen id, and pagination must stay stable under inserts. Offset remained the alternative until we rejected it after reproducing the skip."),
      t("user", "Keyset pagination, ship it."),
    ],
  },

  // ---------------------------------------------------------------- code deep
  // Cue-free on purpose: no conclusion language, so decide() finds nothing
  // here and these sessions never pollute the judge comparison.
  {
    id: "f0000043-0000-4000-8000-000000000043",
    harness: "codex",
    project: "/repo/narwhal",
    startedAt: "2026-04-28T09:00:00Z",
    turns: [
      t("user", "Where does the rate limiter reset its counters?"),
      t("assistant", "`resetWindow` in src/net/ratelimit.ts zeroes the token bucket every 60 seconds using a monotonic clock, so NTP jumps never grant extra quota."),
      t("assistant", "The bucket holds 100 tokens per key with a refill of 2 per second. Bursts pass; sustained floods get 429s with a Retry-After header."),
      t("user", "Does it share state across workers?"),
      t("assistant", "No — each worker keeps a local bucket, and the gateway caps workers at eight, which bounds the overshoot to 8x in the worst case."),
    ],
  },
  {
    id: "f0000044-0000-4000-8000-000000000044",
    harness: "claude-code",
    project: "/repo/narwhal",
    startedAt: "2026-04-29T09:00:00Z",
    turns: [
      t("user", "How do offline edits survive a restart?"),
      t("assistant", "`OutboxStore` in src/sync/outbox.ts appends every mutation to a durable queue before attempting upload, keyed by document id with a vector clock."),
      t("assistant", "On reconnect the queue replays in causal order and drops entries the server already acknowledged. Unsent entries persist across restarts in IndexedDB."),
      t("user", "What caps the queue size?"),
      t("assistant", "Ten thousand entries; beyond that the oldest non-critical presence entries get compacted into a single snapshot marker."),
    ],
  },
  {
    id: "f0000045-0000-4000-8000-000000000045",
    harness: "codex",
    project: "/repo/narwhal",
    startedAt: "2026-04-30T09:00:00Z",
    turns: [
      t("user", "How does full-text search handle partial words?"),
      t("assistant", "`buildTrigrams` in src/search/index.ts splits every token into overlapping 3-character grams at index time, so typing half a word still matches."),
      t("assistant", "The trigram table lives beside the document index and merges results by document id. Three-letter minimum keeps the index small enough for the main thread."),
      t("user", "Non-English text?"),
      t("assistant", "Normalization strips diacritics first, so resume matches résumé, and CJK falls back to bigram splitting."),
    ],
  },
  {
    id: "f0000046-0000-4000-8000-000000000046",
    harness: "claude-code",
    project: "/repo/narwhal",
    startedAt: "2026-05-01T09:00:00Z",
    turns: [
      t("user", "How are notifications delivered to all collaborators?"),
      t("assistant", "`FanoutQueue.publish` in src/notify/fanout.ts writes once to the notification log, then worker tasks push per-user inboxes with at-least-once semantics."),
      t("assistant", "Dedup keys on the client collapse retries, so a flaky connection shows one toast instead of five. High-priority mentions skip the batching window entirely."),
      t("user", "Order guarantees?"),
      t("assistant", "Per-sender ordering only; cross-user ordering was dropped as too expensive after the load test."),
    ],
  },
  {
    id: "f0000047-0000-4000-8000-000000000047",
    harness: "codex",
    project: "/repo/narwhal",
    startedAt: "2026-05-02T09:00:00Z",
    turns: [
      t("user", "How do cursor positions survive concurrent edits?"),
      t("assistant", "`mapPosition` in src/collab/cursor-map.ts translates a cursor offset through remote operations using the same transform as text, so cursors stick to their anchor characters."),
      t("assistant", "When the anchor text is deleted the cursor jumps to the nearest surviving neighbor and marks itself stale. Peers render stale cursors with a dashed outline."),
      t("user", "Interaction with presence batching?"),
      t("assistant", "Mapping runs before `PresenceChannel.publish` batches the frame, so the 50ms tick always carries post-transform positions."),
    ],
  },
  {
    id: "f0000048-0000-4000-8000-000000000048",
    harness: "claude-code",
    project: "/repo/narwhal",
    startedAt: "2026-05-03T09:00:00Z",
    turns: [
      t("user", "How does token refresh avoid race conditions?"),
      t("assistant", "`rotateTokens` in src/auth/refresh.ts holds a per-user mutex during the refresh grant, so ten parallel 401s trigger exactly one rotation."),
      t("assistant", "The old token stays valid for a 30-second grace window while clients swap to the new one. Refresh tokens rotate on every use and the family chain detects reuse."),
      t("user", "Reuse detection consequence?"),
      t("assistant", "The whole token family is revoked and the user gets logged out with a security notice."),
    ],
  },
  {
    id: "f0000049-0000-4000-8000-000000000049",
    harness: "codex",
    project: "/repo/narwhal",
    startedAt: "2026-05-04T09:00:00Z",
    turns: [
      t("user", "How are collaborator avatars generated?"),
      t("assistant", "`renderAvatar` in src/media/avatars.ts hashes the user id into a hue and draws initials on a canvas tile, cached by (userId, size) in memory."),
      t("assistant", "The cache holds 200 tiles with LRU eviction. Remote images load lazily and fall back to initials on failure."),
      t("user", "Dark mode?"),
      t("assistant", "Luminance gets clamped so tiles stay readable on both themes."),
    ],
  },
  {
    id: "f0000050-0000-4000-8000-000000000050",
    harness: "claude-code",
    project: "/repo/narwhal",
    startedAt: "2026-05-05T09:00:00Z",
    turns: [
      t("user", "Where do admin actions get recorded?"),
      t("assistant", "`AuditWriter.append` in src/audit/writer.ts writes hash-chained entries to the audit log, so tampering breaks the chain visibly."),
      t("assistant", "Each entry carries actor, action, target and a monotonic sequence number. Verification replays the chain nightly and pages on mismatch."),
      t("user", "Retention?"),
      t("assistant", "Seven years in cold storage, per the enterprise contracts."),
    ],
  },
  {
    id: "f0000051-0000-4000-8000-000000000051",
    harness: "codex",
    project: "/repo/narwhal",
    startedAt: "2026-05-06T09:00:00Z",
    turns: [
      t("user", "What happens when a webhook delivery fails?"),
      t("assistant", "`RetryQueue.enqueue` in src/billing/retry.ts parks the failed delivery with exponential backoff and routes poison messages to a dead-letter queue after eight attempts."),
      t("assistant", "The dead-letter queue keeps the payload and headers for manual replay from the admin panel. Alerts fire after three consecutive poison events."),
      t("user", "Idempotency on replay?"),
      t("assistant", "Receivers dedupe by event id, so replays never double-charge."),
    ],
  },
  {
    id: "f0000052-0000-4000-8000-000000000052",
    harness: "claude-code",
    project: "/repo/narwhal",
    startedAt: "2026-05-07T09:00:00Z",
    turns: [
      t("user", "How does document export to markdown work?"),
      t("assistant", "`exportMarkdown` in src/export/markdown.ts walks the document tree and emits CommonMark, converting comment threads to blockquotes with author tags."),
      t("assistant", "Embedded images become relative links into an assets folder. Tables wider than 120 characters get wrapped with an HTML fallback."),
      t("user", "Round-trip fidelity?"),
      t("assistant", "Headings, lists and code spans survive; live cursors and presence obviously do not export."),
    ],
  },
  {
    id: "f0000053-0000-4000-8000-000000000053",
    harness: "codex",
    project: "/repo/narwhal",
    startedAt: "2026-05-08T09:00:00Z",
    turns: [
      t("user", "Where are keyboard shortcuts defined?"),
      t("assistant", "`ShortcutRegistry` in src/ui/shortcuts.ts maps chord strings like `cmd-shift-p` to command ids, with per-platform overrides for ctrl versus cmd."),
      t("assistant", "Conflicts surface at registration time in development builds. Users remap through the settings panel, stored as (commandId, chord) pairs."),
      t("user", "Chord timeout?"),
      t("assistant", "One second between keystrokes; longer gaps reset the pending chord."),
    ],
  },
  {
    id: "f0000054-0000-4000-8000-000000000054",
    harness: "claude-code",
    project: "/repo/narwhal",
    startedAt: "2026-05-09T09:00:00Z",
    turns: [
      t("user", "How does the conflict banner decide what to show?"),
      t("assistant", "`ConflictBanner` in src/ui/conflicts.ts lists unmerged remote operations grouped by paragraph, with accept-mine and accept-theirs per group."),
      t("assistant", "The banner appears only when the merge leaves inline markers. Dismissing without resolving keeps the markers and mutes the banner for the session."),
      t("user", "Mobile layout?"),
      t("assistant", "Groups collapse into an expandable sheet below the toolbar."),
    ],
  },
  {
    id: "f0000055-0000-4000-8000-000000000055",
    harness: "codex",
    project: "/repo/narwhal",
    startedAt: "2026-05-10T09:00:00Z",
    turns: [
      t("user", "How does session restore work after a crash?"),
      t("assistant", "`restoreFromCheckpoint` in src/net/restore.ts replays the checkpoint journal into a fresh document snapshot, then re-applies outbox entries newer than the checkpoint."),
      t("assistant", "Checkpoints land every 50 operations or 30 seconds, whichever comes first. A corrupt checkpoint falls back to the previous one automatically."),
      t("user", "Interaction with snapshot compaction?"),
      t("assistant", "Compaction never touches the newest checkpoint per document, so restore always has a base even for cold documents."),
    ],
  },
  {
    id: "f0000056-0000-4000-8000-000000000056",
    harness: "claude-code",
    project: "/repo/narwhal",
    startedAt: "2026-05-11T09:00:00Z",
    turns: [
      t("user", "How are client metrics batched?"),
      t("assistant", "`MetricsBatcher` in src/metrics/batch.ts accumulates counters in memory and flushes every 15 seconds or 500 events, whichever comes first."),
      t("assistant", "Flushes carry a session id and a monotonic sequence so the backend drops duplicates. Sampling trims high-volume cursor events to one percent."),
      t("user", "Offline behavior?"),
      t("assistant", "Batches persist to IndexedDB when the network drops and upload on reconnect."),
    ],
  },

  // ------------------------------------------------------- code distractors
  // Shallow status updates naming code topics without detail (same role as
  // session 011 for the original code queries).
  {
    id: "f0000057-0000-4000-8000-000000000057",
    harness: "claude-code",
    project: "/repo/narwhal",
    startedAt: "2026-05-12T09:00:00Z",
    turns: [
      t("user", "Status on the rate limiter, outbox, search tokenizer and notification fanout work?"),
      t("assistant", "All four branches are in review. The ratelimit reset branch, the outbox replay branch, the trigram index branch and the fanout dedup branch wait on the same reviewer."),
      t("user", "And the token refresh rotation?"),
      t("assistant", "Refresh rotation is unchanged this week. No code moved in src/auth/refresh.ts."),
    ],
  },
  {
    id: "f0000058-0000-4000-8000-000000000058",
    harness: "codex",
    project: "/repo/narwhal",
    startedAt: "2026-05-13T09:00:00Z",
    turns: [
      t("user", "Status on avatars, audit log, webhook retry, export, shortcuts, conflicts, restore and metrics?"),
      t("assistant", "Avatar tiles, audit chaining, retry dead-letter, markdown export and shortcut chords are all in review with the same reviewer."),
      t("user", "Conflict banner, session restore, metrics batcher?"),
      t("assistant", "No movement this week. Nothing changed in src/ui/conflicts.ts, src/net/restore.ts or src/metrics/batch.ts."),
    ],
  },

  // ------------------------------------------------------ paraphrase targets
  // Technical vocabulary only; golden queries ask in everyday words with no
  // shared stems (verified by running the lexical arm, never by eye). Also
  // cue-free so decide() stays silent here.
  {
    id: "f0000059-0000-4000-8000-000000000059",
    harness: "claude-code",
    project: "/repo/narwhal",
    startedAt: "2026-05-14T09:00:00Z",
    turns: [
      t("user", "Gallery scrolling stutters on large boards."),
      t("assistant", "Each thumbnail decodes the full attachment on the main thread during scroll, which blocks frames for 200ms apiece."),
      t("assistant", "Moving thumbnail decode into an offscreen worker with a canvas pool removed the jank entirely. Tiles now paint from cached bitmaps."),
      t("user", "Memory impact?"),
      t("assistant", "The bitmap pool caps at 40 entries; evicted tiles re-decode on demand."),
    ],
  },
  {
    id: "f0000060-0000-4000-8000-000000000060",
    harness: "codex",
    project: "/repo/narwhal",
    startedAt: "2026-05-15T09:00:00Z",
    turns: [
      t("user", "Support tickets repeat a handful of setup questions."),
      t("assistant", "The handbook buries prerequisites three pages deep, so readers skim past the access token step and fail at first sync."),
      t("assistant", "Rewriting the handbook as a numbered checklist with the token step first cut the repeat tickets to nearly zero within a month."),
      t("user", "Translations?"),
      t("assistant", "Checklist structure ports cleanly; translators finished all six locales in a week."),
    ],
  },
  {
    id: "f0000061-0000-4000-8000-000000000061",
    harness: "claude-code",
    project: "/repo/narwhal",
    startedAt: "2026-05-16T09:00:00Z",
    turns: [
      t("user", "Merges queue up every afternoon."),
      t("assistant", "The integration pipeline reruns the entire matrix on every push, so a one-line docs change burns forty minutes of runners."),
      t("assistant", "Splitting the pipeline by changed paths means docs edits run a two-minute lane while code changes run the full matrix. The afternoon queue vanished."),
      t("user", "Flake rate?"),
      t("assistant", "Quarantining the three flaky browser specs removed the last red builds."),
    ],
  },
  {
    id: "f0000062-0000-4000-8000-000000000062",
    harness: "codex",
    project: "/repo/narwhal",
    startedAt: "2026-05-17T09:00:00Z",
    turns: [
      t("user", "People mute the whole workspace within a week."),
      t("assistant", "Every cursor move and comment fires a toast, so the signal drowns in a hundred pings a day."),
      t("assistant", "Batching low-priority pings into a twice-daily digest while keeping mentions instant dropped mute rates by two thirds."),
      t("user", "Weekend behavior?"),
      t("assistant", "Digests pause on weekends; Monday carries a single rollup."),
    ],
  },
  {
    id: "f0000063-0000-4000-8000-000000000063",
    harness: "claude-code",
    project: "/repo/narwhal",
    startedAt: "2026-05-18T09:00:00Z",
    turns: [
      t("user", "Search returns ancient docs above fresh ones."),
      t("assistant", "The index scores purely on term overlap, so an archived doc stuffed with keywords beats yesterday's fix."),
      t("assistant", "Adding a time-decay factor to the score demoted the archives without hiding them. Fresh fixes now surface first for overlapping terms."),
      t("user", "Tuning knobs?"),
      t("assistant", "Half-life defaults to ninety days; team leads adjust per collection."),
    ],
  },
  {
    id: "f0000064-0000-4000-8000-000000000064",
    harness: "codex",
    project: "/repo/narwhal",
    startedAt: "2026-05-19T09:00:00Z",
    turns: [
      t("user", "Engineering output dips every Wednesday."),
      t("assistant", "The calendar scatters thirty-minute syncs across the whole day, so nobody holds a two-hour block for deep work."),
      t("assistant", "Clustering every recurring sync into Tuesday and Thursday mornings restored full open days. Wednesday output recovered within two sprints."),
      t("user", "Customer calls?"),
      t("assistant", "Those stay bookable anytime; only internal syncs moved."),
    ],
  },
  {
    id: "f0000065-0000-4000-8000-000000000065",
    harness: "claude-code",
    project: "/repo/narwhal",
    startedAt: "2026-05-20T09:00:00Z",
    turns: [
      t("user", "Half the helpdesk queue is lockouts."),
      t("assistant", "The reset link expires after fifteen minutes, but the email gateway batches sends hourly, so links die before arrival."),
      t("assistant", "Extending link lifetime to a day and sending through the priority lane cleared the queue. Lockouts now resolve without staff touch."),
      t("user", "Abuse vector?"),
      t("assistant", "Links stay single-use and bind to the requesting device fingerprint."),
    ],
  },
  {
    id: "f0000066-0000-4000-8000-000000000066",
    harness: "codex",
    project: "/repo/narwhal",
    startedAt: "2026-05-21T09:00:00Z",
    turns: [
      t("user", "Exec reviews quote numbers that contradict the product board."),
      t("assistant", "The dashboard snapshot refreshes nightly while the board reads live, so morning meetings compare different vintages."),
      t("assistant", "Stamping every number with its refresh timestamp ended the arguments. Readers now check the stamp before quoting."),
      t("user", "Timezone handling?"),
      t("assistant", "Stamps render in viewer-local time with the source zone in a tooltip."),
    ],
  },
  {
    id: "f0000067-0000-4000-8000-000000000067",
    harness: "claude-code",
    project: "/repo/narwhal",
    startedAt: "2026-05-22T09:00:00Z",
    turns: [
      t("user", "Field testers report dead phones by noon."),
      t("assistant", "The location poller wakes the radio every twenty seconds even when the document sits idle in a pocket."),
      t("assistant", "Backing the poller off to five-minute intervals while idle stretched battery past dinner. Active editing keeps the twenty-second cadence."),
      t("user", "Permissions fallout?"),
      t("assistant", "Background location now prompts with an explainer, and opt-outs tripled without complaints."),
    ],
  },
  {
    id: "f0000068-0000-4000-8000-000000000068",
    harness: "codex",
    project: "/repo/narwhal",
    startedAt: "2026-05-23T09:00:00Z",
    turns: [
      t("user", "Deploys pause writes for nine minutes."),
      t("assistant", "The migration rewrites the whole documents table to add a column, locking it for the duration."),
      t("assistant", "Switching to expand-contract — new column nullable first, backfill lazily, drop old reads last — shrank the pause to seconds."),
      t("user", "Rollback story?"),
      t("assistant", "Each phase goes out separately, so any stage reverts without touching user rows."),
    ],
  },
  {
    id: "f0000069-0000-4000-8000-000000000069",
    harness: "claude-code",
    project: "/repo/narwhal",
    startedAt: "2026-05-24T09:00:00Z",
    turns: [
      t("user", "Observability spend exceeds compute spend."),
      t("assistant", "Debug verbosity ships to production, so each cursor heartbeat emits a JSON blob with full context."),
      t("assistant", "Sampling heartbeats at one percent and dropping context from info lines cut volume twenty-fold. Traces stay unsampled for errors."),
      t("user", "Cold-start coverage?"),
      t("assistant", "First minute after boot logs everything; sampling engages after."),
    ],
  },
  {
    id: "f0000070-0000-4000-8000-000000000070",
    harness: "codex",
    project: "/repo/narwhal",
    startedAt: "2026-05-25T09:00:00Z",
    turns: [
      t("user", "Reminder emails arrive at 3am for Sydney users."),
      t("assistant", "The scheduler stores wall-clock times without a zone, then interprets them on a server pinned to Pacific."),
      t("assistant", "Persisting UTC instants and rendering per-recipient zones fixed Sydney overnight. Daylight transitions now pass the regression pack."),
      t("user", "Existing reminders?"),
      t("assistant", "A one-off migration reinterpreted stored times as Pacific before converting."),
    ],
  },

  // ---------------------------------------------------------- general filler
  // Dead-end planning topics with no golden queries: corpus size without
  // retrieval interference. A second unrelated project session like 012.
  {
    id: "f0000071-0000-4000-8000-000000000071",
    harness: "claude-code",
    project: "/repo/narwhal",
    startedAt: "2026-05-26T09:00:00Z",
    turns: [
      t("user", "Q3 planning: we need to look at a desktop shell and a public API."),
      t("assistant", "Electron versus Tauri for the shell, and GraphQL versus REST for the public API, are the two open items."),
      t("user", "Anything decided?"),
      t("assistant", "Nothing concluded on either. Both stay on the parking lot until after the mobile launch."),
    ],
  },
  {
    id: "f0000072-0000-4000-8000-000000000072",
    harness: "codex",
    project: "/repo/ferret",
    startedAt: "2026-05-27T09:00:00Z",
    turns: [
      t("user", "Ferret budget import chokes on bank CSVs with multi-line memos."),
      t("assistant", "The CSV parser splits on newlines before handling quotes, so a quoted memo with a line break becomes two broken rows."),
      t("assistant", "Parsing quotes first and only then splitting rows fixed the import. The budget totals now reconcile with the bank statements."),
      t("user", "Export back out?"),
      t("assistant", "Exports quote every memo field, so round-trips stay clean."),
    ],
  },
];

/**
 * Materialise the corpus into the adapters' native on-disk formats.
 * Returns the two base dirs, ready for `createApp({ claudeDir, codexDir })`.
 */
export async function buildFixtureCorpus(root: string): Promise<{ claudeDir: string; codexDir: string }> {
  const claudeDir = join(root, "claude");
  const codexDir = join(root, "codex");

  for (const s of FIXTURE_SESSIONS) {
    const started = new Date(s.startedAt).getTime();
    // One minute between turns, so ordering and asOf bounds are predictable.
    const stamp = (i: number) => new Date(started + i * 60_000).toISOString();

    if (s.harness === "claude-code") {
      // ~/.claude/projects/<project>/<sessionId>.jsonl
      const dir = join(claudeDir, s.project.replace(/[^a-zA-Z0-9]+/g, "-"));
      await mkdir(dir, { recursive: true });
      const lines = s.turns.map((turn, i) =>
        JSON.stringify({
          type: turn.role,
          uuid: `${s.id}-u${i}`,
          parentUuid: i === 0 ? null : `${s.id}-u${i - 1}`,
          timestamp: stamp(i),
          sessionId: s.id,
          cwd: s.project,
          message: { role: turn.role, content: turn.content },
        }),
      );
      await writeFile(join(dir, `${s.id}.jsonl`), lines.join("\n") + "\n");
    } else {
      // ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl, session_meta first.
      const d = new Date(s.startedAt);
      const dir = join(
        codexDir,
        String(d.getUTCFullYear()),
        String(d.getUTCMonth() + 1).padStart(2, "0"),
        String(d.getUTCDate()).padStart(2, "0"),
      );
      await mkdir(dir, { recursive: true });
      const lines = [
        JSON.stringify({
          type: "session_meta",
          timestamp: s.startedAt,
          payload: { session_id: s.id, timestamp: s.startedAt, cwd: s.project, originator: "fixture" },
        }),
        ...s.turns.map((turn, i) =>
          JSON.stringify({
            type: "response_item",
            timestamp: stamp(i),
            payload: { type: "message", role: turn.role, id: `${s.id}-r${i}`, content: turn.content },
          }),
        ),
      ];
      await writeFile(join(dir, `rollout-${s.id}.jsonl`), lines.join("\n") + "\n");
    }
  }

  return { claudeDir, codexDir };
}
