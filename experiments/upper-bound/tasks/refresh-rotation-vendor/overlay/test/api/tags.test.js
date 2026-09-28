import { test } from "node:test";
import assert from "node:assert/strict";
import { TagsApi } from "../../src/api/tags.js";

test("tags: get encodes the id", async () => {
  let seen;
  const api = { get: async (p) => { seen = p; return {}; } };
  await new TagsApi(api).get("a/b");
  assert.equal(seen, "/tags/a%2Fb");
});
