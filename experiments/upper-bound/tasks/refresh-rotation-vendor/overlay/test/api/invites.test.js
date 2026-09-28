import { test } from "node:test";
import assert from "node:assert/strict";
import { InvitesApi } from "../../src/api/invites.js";

test("invites: get encodes the id", async () => {
  let seen;
  const api = { get: async (p) => { seen = p; return {}; } };
  await new InvitesApi(api).get("a/b");
  assert.equal(seen, "/invites/a%2Fb");
});
