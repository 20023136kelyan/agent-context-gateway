import { test } from "node:test";
import assert from "node:assert/strict";
import { DomainsApi } from "../../src/api/domains.js";

test("domains: get encodes the id", async () => {
  let seen;
  const api = { get: async (p) => { seen = p; return {}; } };
  await new DomainsApi(api).get("a/b");
  assert.equal(seen, "/domains/a%2Fb");
});
