/**
 * Global test setup.
 *
 * Pins the Jev endpoint to an unroutable address so no test can reach the
 * vendor, whatever is in the developer's environment.
 *
 * This became necessary when reranking flipped to default-ON. Before that, a
 * test had to ask for reranking explicitly; now any test that runs a search
 * reranks, and a developer with TYPESAFE_API_KEY exported would send the whole
 * suite's query text to a third party on every `npm test` — and get
 * rate-limited for it. A full run was observed logging `jev-http-429`.
 *
 * Failing to connect is the correct outcome here: `JevReranker` and
 * `JevDecisionJudge` both degrade to retrieval order on any error, so the code
 * under test still exercises its real failure path. Tests that want judged
 * behaviour inject a fake client instead (see tests/judge-jev.test.ts), which
 * is the only honest way to assert on a model's output anyway.
 *
 * Set JEV_ENDPOINT explicitly before vitest to override, if a live smoke test
 * is ever wanted.
 */
if (!process.env.JEV_ENDPOINT) {
  // Port 1 on loopback: refuses immediately rather than hanging on a timeout.
  process.env.JEV_ENDPOINT = "http://127.0.0.1:1/jev-disabled-in-tests";
}

/*
 * Every test file gets a private state dir unless it chose one. Without this a
 * test that syncs without naming a state dir writes derived stores (the action
 * index, feedback, topology) into the developer's real ~/.context-gateway: a
 * full run once created ~/.context-gateway/actions.sqlite that way.
 */
if (!process.env.CONTEXT_GATEWAY_STATE) {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  process.env.CONTEXT_GATEWAY_STATE = mkdtempSync(join(tmpdir(), "acg-test-state-"));
}
