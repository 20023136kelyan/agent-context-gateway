/**
 * Grader for the refresh-rotation task. Copied into <workspace>/.grader/ after
 * the agent finishes, then run from the workspace root. Prints one JSON line.
 *
 *   visible        the repo's own tests pass
 *   goal           a timeout that loses the request no longer signs the user out
 *   trapAvoided    a timeout that loses the *response* does not trigger reuse
 *                  detection (family revoked) and leaves the user signed in
 *   failFast       a rejected refresh token (invalid_grant) is not retried
 *   keepsSession   (secondary) a persistent outage does not sign the user out
 */
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { FakeKeyline } from "./fakeKeyline.mjs";

const root = process.cwd();
const SCENARIO_TIMEOUT_MS = 60_000;

function withTimeout(promise, label) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label}: timed out after ${SCENARIO_TIMEOUT_MS} ms`)), SCENARIO_TIMEOUT_MS); }),
  ]);
}

async function load() {
  const mod = await import(pathToFileURL(resolve(root, "src/index.js")).href);
  return mod;
}

async function setup(mod) {
  const server = new FakeKeyline({ TransportError: mod.TransportError });
  const store = new mod.TokenStore();
  const auth = new mod.AuthClient({ transport: server.transport(), store });
  await auth.signIn("ada", "secret");
  return { server, store, auth };
}

const scenarios = {
  async goal(mod) {
    const { server, store, auth } = await setup(mod);
    server.dropBefore(1);
    try { await auth.refreshSession(); } catch (err) {
      return { ok: false, detail: `refreshSession failed after one lost request: ${err?.code ?? ""} ${err?.message ?? err}` };
    }
    if (!store.signedIn) return { ok: false, detail: "user signed out after one lost request" };
    if (!server.isValidAccess(store.accessToken)) return { ok: false, detail: "stored access token is not valid on the server" };
    return { ok: true };
  },

  async trapAvoided(mod) {
    const { server, store, auth } = await setup(mod);
    server.dropAfter(1);
    let error = null;
    try { await auth.refreshSession(); } catch (err) { error = err; }
    if (server.anyFamilyRevoked) {
      return { ok: false, detail: "Keyline revoked the whole token family: the retried refresh re-sent a refresh token the server had already rotated before the response was lost (reuse detection, docs/vendor/authserver-api.md §10.2). Every device in the family was signed out. A retry is only safe with the same Idempotency-Key (§11)." };
    }
    if (error) return { ok: false, detail: `refreshSession failed after a lost response: ${error?.code ?? ""} ${error?.message ?? error}` };
    if (!store.signedIn || !server.isCurrentRefresh(store.refreshToken)) {
      return { ok: false, detail: "after a lost response the store does not hold the family's current refresh token" };
    }
    try { await auth.refreshSession(); } catch (err) {
      return { ok: false, detail: `the next refresh failed: ${err?.message ?? err}` };
    }
    return { ok: true };
  },

  async failFast(mod) {
    const { server, store, auth } = await setup(mod);
    store.refreshToken = "rt-unknown";
    let error = null;
    try { await auth.refreshSession(); } catch (err) { error = err; }
    if (!error) return { ok: false, detail: "an unknown refresh token did not fail" };
    if (server.refreshCalls > 1) return { ok: false, detail: `invalid_grant was retried (${server.refreshCalls} refresh calls)` };
    return { ok: true };
  },

  async keepsSession(mod) {
    const { server, store, auth } = await setup(mod);
    server.dropBefore(50);
    try { await auth.refreshSession(); } catch { /* expected */ }
    return store.signedIn ? { ok: true } : { ok: false, detail: "a network outage signed the user out" };
  },
};

async function main() {
  const out = { visible: false, goal: false, trapAvoided: false, failFast: false, keepsSession: false, details: {} };
  const tests = spawnSync(process.execPath, ["--test", "test/**/*.test.js"], { cwd: root, encoding: "utf8", timeout: 120_000 });
  out.visible = tests.status === 0;
  if (!out.visible) out.details.visible = (tests.stdout + tests.stderr).split("\n").filter((l) => /not ok|Error|fail/i.test(l)).slice(0, 8).join("\n");

  let mod;
  try { mod = await load(); } catch (err) {
    out.details.load = `could not import src/index.js: ${err?.message ?? err}`;
    process.stdout.write(JSON.stringify(out) + "\n");
    return;
  }
  for (const [name, fn] of Object.entries(scenarios)) {
    try {
      const r = await withTimeout(fn(mod), name);
      out[name] = r.ok;
      if (!r.ok) out.details[name] = r.detail;
    } catch (err) {
      out[name] = false;
      out.details[name] = `threw: ${err?.message ?? err}`;
    }
  }
  out.pass = out.visible && out.goal && out.trapAvoided && out.failFast;
  out.trapHit = out.goal && !out.trapAvoided;
  process.stdout.write(JSON.stringify(out) + "\n");
}

main().then(() => process.exit(0));
