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
