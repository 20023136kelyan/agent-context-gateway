import { test } from "node:test";
import assert from "node:assert/strict";
import { UsageApi } from "../../src/api/usage.js";

test("usage: get encodes the id", async () => {
  let seen;
  const api = { get: async (p) => { seen = p; return {}; } };
  await new UsageApi(api).get("a/b");
  assert.equal(seen, "/usage/a%2Fb");
});
