import { test } from "node:test";
import assert from "node:assert/strict";
import { AuthClient, SessionGuard, TokenStore } from "../src/index.js";
import { FakeTokenServer } from "./fakeServer.js";

function setup() {
  const server = new FakeTokenServer();
  const store = new TokenStore();
  const auth = new AuthClient({ transport: server.transport(), store });
  return { server, store, auth };
}

test("signIn stores the token pair", async () => {
  const { store, auth } = setup();
  await auth.signIn("ada", "secret");
  assert.equal(store.accessToken, "at-1");
  assert.equal(store.refreshToken, "rt-1");
});

test("refreshSession stores the new pair", async () => {
  const { store, auth } = setup();
  await auth.signIn("ada", "secret");
  const token = await auth.refreshSession();
  assert.equal(token, "at-2");
  assert.equal(store.refreshToken, "rt-2");
});

test("a rejected refresh token signs the user out", async () => {
  const { store, auth } = setup();
  await auth.signIn("ada", "secret");
  store.refreshToken = "rt-unknown";
  await assert.rejects(auth.refreshSession(), { code: "invalid_grant" });
  assert.equal(store.signedIn, false);
});

test("SessionGuard refreshes once on 401 and retries the call", async () => {
  const { store, auth } = setup();
  await auth.signIn("ada", "secret");
  const guard = new SessionGuard({ auth, store });
  const seen = [];
  const res = await guard.run(async (token) => {
    seen.push(token);
    return token === "at-1" ? { status: 401, body: null } : { status: 200, body: { ok: true } };
  });
  assert.equal(res.status, 200);
  assert.deepEqual(seen, ["at-1", "at-2"]);
});
