import { test } from "node:test";
import assert from "node:assert/strict";
import { PoliciesApi } from "../../src/api/policies.js";

test("policies: get encodes the id", async () => {
  let seen;
  const api = { get: async (p) => { seen = p; return {}; } };
  await new PoliciesApi(api).get("a/b");
  assert.equal(seen, "/policies/a%2Fb");
});
