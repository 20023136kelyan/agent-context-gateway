import { test } from "node:test";
import assert from "node:assert/strict";
import { ThreadsApi } from "../../src/api/threads.js";

test("threads: get encodes the id", async () => {
  let seen;
  const api = { get: async (p) => { seen = p; return {}; } };
  await new ThreadsApi(api).get("a/b");
  assert.equal(seen, "/threads/a%2Fb");
});
