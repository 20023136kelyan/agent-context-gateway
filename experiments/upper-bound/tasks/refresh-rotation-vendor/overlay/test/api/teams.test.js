import { test } from "node:test";
import assert from "node:assert/strict";
import { TeamsApi } from "../../src/api/teams.js";

test("teams: get encodes the id", async () => {
  let seen;
  const api = { get: async (p) => { seen = p; return {}; } };
  await new TeamsApi(api).get("a/b");
  assert.equal(seen, "/teams/a%2Fb");
});
