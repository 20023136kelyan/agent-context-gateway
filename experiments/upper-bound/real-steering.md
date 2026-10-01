# Real steering: one long session

A first look at how often a user steers an agent in practice, and what kind of
knowledge the steering carries. Source: the user's own messages in the Claude Code
session that designed Bifröst and ran these experiments (49 messages over several
days; product design, documents and experiment work rather than everyday coding).
`tools/export-steering.mjs` extracts the same data from OpenCode's local database
for the user's coding sessions.

## Counts

| Kind | Messages | Examples (paraphrased) |
|---|---|---|
| Correction of the agent's understanding or approach | 7 | "That's not what I meant by updating the approach"; "the work layer is Bifröst, the whole product is Bifröst"; "it isn't in the code, it works on top of a code map"; "you have the wrong idea: Bifröst is a service, it doesn't use the user's model"; "Graphify works with Codex and Cursor too"; "why are you running things?" (study first); the four points on what notes are for |
| Preference or convention (taste) | 5 | Rename to Bifröst with the proper spelling; corporate documents keep internal analogies out; a description doc is a summary, how it works and one example flow; use the free Muse Spark model at `xhigh`; run one task before scaling up |
| Decision or fact about the project | 7 | The new direction goes on a new branch; how the product works, explained through an internal analogy; agent work becomes events that are classified, then added, updated or dismissed; presence must know whether an agent is working and on what; a hosted model generates the notes; the user codes with OpenCode and has no local subscriptions; network access was widened |
| Direction ("go", "how is it", questions) | 30 | |

**19 of 49 messages (39%) carried knowledge the agent did not have.** Of those 19,
one could have been found by searching (Graphify's supported clients are in its
own docs). The other 18 lived only in the user's head.

## What this says for Bifröst

- **Most steering is not findable.** Product decisions, naming, document style and
  the user's own setup are exactly the "absent from the repository" class where
  notes took agents from 0% to 100% in the experiments.
- **Much of it lasts beyond the session.** The naming, keeping internal analogies
  out of corporate documents, the service model and the user's toolchain hold for
  every later session and every other agent. Without a shared record, each new
  agent has to be corrected again.
- **Corrections often target a conclusion, not code.** Several corrections
  replaced the agent's model of the product, and one extended the agent's own
  analysis of the experiment results. That kind of item has no single file to
  anchor to; it belongs to the project, or to a folder such as `docs/`.

One session, one user, and mostly design work: a sanity check, not a measurement.
The OpenCode export of coding sessions is the next source.
