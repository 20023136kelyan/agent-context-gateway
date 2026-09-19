# Fixture Corpus Expansion Brief

Expand the Agent Context Gateway evaluation corpus from 12 sessions to roughly
60–100, and its golden set from 15 queries to roughly 60–100, without losing the
properties that let it tell retrieval arms apart — and add the one case it
currently cannot produce.

## Context

`tests/fixtures/corpus.ts` holds a synthetic corpus of 12 sessions that the
evaluation harness uses instead of real agent history, so eval is reproducible on
any machine and safe to run in CI. `tests/eval/golden-fixture.json` holds 15
golden queries against it. Everything in it is invented — no real data, ever.

The corpus is built to **discriminate between retrieval arms**. A corpus where
lexical BM25 already answers every query cannot tell a lexical arm from a
reranked one, so it cannot measure anything. Its current numbers, all arms
sharing identical retrieval and differing only in reranker, run in one process:

| Arm | NDCG@5 | P@1 |
| --- | ---: | ---: |
| lexical | 0.628 | 0.333 |
| lexical + cross-encoder | 0.702 | 0.533 |
| lexical + Jev (pairwise) | 0.839 | 0.800 |

Repo: `/Users/kelyan/dev/ACG`, branch `ACG_JEV`, TypeScript.

Statistical power is the motivation for scaling up: with 15 queries and binary
session-level relevance, an NDCG@5 delta under roughly 0.04 is not evidence. More
queries tighten that bound.

## The blind spot to fix

The decision-judge comparison currently measures nothing: two judges
(cross-encoder and Jev) both score Hit@1 0.667, because the cases where they
would differ never arise.

- When the correct session is retrieved, **both** judges rank it first — too easy
  to separate them.
- When it is not retrieved, **neither** can cite it — that is a retrieval
  failure, not a judging one.

You must create decision cases where the correct session **and** a credible
distractor are both retrieved into the candidate set, forcing the judge to
choose. The mechanics that constrain this:

- `decideOnce` in `src/commands.ts` retrieves `maxResults: 6`, dedupes to at most
  **3 distinct sessions**, extracts decisions from each, then pre-filters to 6
  candidates before judging.
- So the distractor and the real decision must both land in that top-3 session
  set for the same query, with the distractor lexically competitive or stronger.
- The distractor must carry **decision-shaped language** so the heuristic
  extractor emits it as a candidate, while settling nothing — "we need to decide
  whether to X or Y", "the team leaned toward X but nothing is final". The real
  decision must actually conclude and give a reason.

That is the only configuration under which a judge's quality is observable.

One caution: it is entirely possible that Jev is simply not better at judging. If
the arms still tie after a fair attempt, that is a real result worth reporting —
do not shape the corpus to flatter one judge.

## Required properties

All of these must survive the expansion. `tests/fixture-corpus.test.ts` asserts
most of them.

| Property | Why it exists | How to check |
| --- | --- | --- |
| Paraphrase headroom | At least half of `paraphrase` queries must share no stem with their target, so lexical misses them. This is the gap embeddings and judging exist to close. | Run the lexical arm and confirm the miss. Never assume. |
| Distractors that win lexically | Sessions with heavy term overlap answering nothing, so a lexical-only arm ranks them top. This is the precision failure a reranker must fix. | `prose` P@1 should stay well below its NDCG@5 on the lexical arm. |
| Real decisions | Conclusion, rationale and a rejected alternative, using cue phrases the heuristic extractor recognises. | Read `src/decisions/cues.ts` first. |
| Three domains | `code`, `prose`, `paraphrase`, roughly balanced. | The domain test. |
| Both harnesses | `claude-code` and `codex` sessions. | The harness test. |

Two traps worth naming:

- **The Porter stemmer leaks.** `take`/`takes`, `laptop`/`laptops`, `setup`,
  `new` and `first` all matched across what looked like unrelated wording. Three
  paraphrase queries had to be rewritten for exactly this. Verify empirically
  rather than by eye.
- **A session with no cue phrase yields zero decisions**, however decision-like
  it reads to a human. Three of the current six "why-queries" target sessions
  containing no extractable decision at all — which is what made the citation
  metric measure retrieval failure and report it as judge quality.

## Schema and constraints

`FixtureSession` in `tests/fixtures/corpus.ts`:

```typescript
{ id: string;            // uuid-like, STABLE — never renumber existing ones
  harness: "claude-code" | "codex";
  project: string;       // becomes cwd
  startedAt: string;     // ISO
  turns: { role: "user" | "assistant" | "system"; content: string }[] }
```

`GoldenQuery` in `tests/eval/golden-fixture.json`:

```typescript
{ id: string;                       // STABLE
  domain: "code" | "prose" | "paraphrase";
  query: string;
  harness?: "claude-code" | "codex";  // filters search — omit unless certain
  description: string;                // say WHAT makes this query discriminating
  relevantSessionIds: string[];
  decisionQuery?: boolean }           // true ONLY if the target contains an
                                      // extractable decision. Not merely because
                                      // the query starts with "why".
```

Hard constraints:

- **Do not change `buildFixtureCorpus()`** — it already writes both native
  on-disk formats correctly. Add sessions to the array and extend the golden file.
- **Keep every existing session id and query id stable and present.** Add, do not
  replace, so earlier measurements stay comparable.
- No real data, no secrets, nothing machine-specific. The whole point is that
  this runs anywhere, including CI.

## Verification and done

All of these must pass before finishing:

```bash
npm run build
npx vitest run tests/fixture-corpus.test.ts   # headroom invariants
npx vitest run                                # full suite, currently 206 passing

# arm ordering must hold: lexical < cross-encoder < jev
npm run eval -- --mode lexical,lexical-rerank,lexical-jev-pairwise --fixture

# judges must now DIFFER on Hit@1 — this is the new requirement
npm run eval -- --mode judge-neural,judge-jev --fixture
```

The Jev arms need `TYPESAFE_API_KEY`, already present in `.env`. `npm run eval`
loads it; a bare `npx tsx` does not.

Definition of done:

- [ ] Corpus and golden set substantially larger, all existing ids intact
- [ ] `tests/fixture-corpus.test.ts` passes — tighten its thresholds if the
      paraphrase share grows
- [ ] Full suite green
- [ ] Arm ordering preserved on NDCG@5: lexical < cross-encoder < Jev
- [ ] `judge-neural` and `judge-jev` produce different Hit@1, with a short note
      naming which queries discriminate and why
- [ ] No real data, no secrets, nothing machine-specific

If the judges still tie after a fair attempt, say so plainly and name what you
tried. A negative result is worth more than a corpus bent to produce a positive
one.
