import { test } from "node:test";
import assert from "node:assert/strict";
import { FoldersApi } from "../../src/api/folders.js";

test("folders: get encodes the id", async () => {
  let seen;
  const api = { get: async (p) => { seen = p; return {}; } };
  await new FoldersApi(api).get("a/b");
  assert.equal(seen, "/folders/a%2Fb");
});
