import { test } from "node:test";
import assert from "node:assert/strict";
import { TemplatesApi } from "../../src/api/templates.js";

test("templates: get encodes the id", async () => {
  let seen;
  const api = { get: async (p) => { seen = p; return {}; } };
  await new TemplatesApi(api).get("a/b");
  assert.equal(seen, "/templates/a%2Fb");
});
