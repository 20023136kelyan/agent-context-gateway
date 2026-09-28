import { test } from "node:test";
import assert from "node:assert/strict";
import { WebhooksApi } from "../../src/api/webhooks.js";

test("webhooks: get encodes the id", async () => {
  let seen;
  const api = { get: async (p) => { seen = p; return {}; } };
  await new WebhooksApi(api).get("a/b");
  assert.equal(seen, "/webhooks/a%2Fb");
});
