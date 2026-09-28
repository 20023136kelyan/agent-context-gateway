import { test } from "node:test";
import assert from "node:assert/strict";
import { ReactionsApi } from "../../src/api/reactions.js";

test("reactions: get encodes the id", async () => {
  let seen;
  const api = { get: async (p) => { seen = p; return {}; } };
  await new ReactionsApi(api).get("a/b");
  assert.equal(seen, "/reactions/a%2Fb");
});
