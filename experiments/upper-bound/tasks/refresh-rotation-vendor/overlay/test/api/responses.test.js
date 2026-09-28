import { test } from "node:test";
import assert from "node:assert/strict";
import { ResponsesApi } from "../../src/api/responses.js";

test("responses: get encodes the id", async () => {
  let seen;
  const api = { get: async (p) => { seen = p; return {}; } };
  await new ResponsesApi(api).get("a/b");
  assert.equal(seen, "/responses/a%2Fb");
});
