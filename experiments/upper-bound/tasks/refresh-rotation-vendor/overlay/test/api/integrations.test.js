import { test } from "node:test";
import assert from "node:assert/strict";
import { IntegrationsApi } from "../../src/api/integrations.js";

test("integrations: get encodes the id", async () => {
  let seen;
  const api = { get: async (p) => { seen = p; return {}; } };
  await new IntegrationsApi(api).get("a/b");
  assert.equal(seen, "/integrations/a%2Fb");
});
