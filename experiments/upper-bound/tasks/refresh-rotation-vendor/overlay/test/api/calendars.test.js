import { test } from "node:test";
import assert from "node:assert/strict";
import { CalendarsApi } from "../../src/api/calendars.js";

test("calendars: get encodes the id", async () => {
  let seen;
  const api = { get: async (p) => { seen = p; return {}; } };
  await new CalendarsApi(api).get("a/b");
  assert.equal(seen, "/calendars/a%2Fb");
});
