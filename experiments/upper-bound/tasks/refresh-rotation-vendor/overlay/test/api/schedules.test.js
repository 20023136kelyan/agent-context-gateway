import { test } from "node:test";
import assert from "node:assert/strict";
import { SchedulesApi } from "../../src/api/schedules.js";

test("schedules: get encodes the id", async () => {
  let seen;
  const api = { get: async (p) => { seen = p; return {}; } };
  await new SchedulesApi(api).get("a/b");
  assert.equal(seen, "/schedules/a%2Fb");
});
