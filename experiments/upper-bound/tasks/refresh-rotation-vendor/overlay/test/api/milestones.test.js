import { test } from "node:test";
import assert from "node:assert/strict";
import { MilestonesApi } from "../../src/api/milestones.js";

test("milestones: get encodes the id", async () => {
  let seen;
  const api = { get: async (p) => { seen = p; return {}; } };
  await new MilestonesApi(api).get("a/b");
  assert.equal(seen, "/milestones/a%2Fb");
});
