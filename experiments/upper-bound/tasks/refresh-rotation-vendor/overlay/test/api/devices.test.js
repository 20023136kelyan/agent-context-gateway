import { test } from "node:test";
import assert from "node:assert/strict";
import { DevicesApi } from "../../src/api/devices.js";

test("devices: get encodes the id", async () => {
  let seen;
  const api = { get: async (p) => { seen = p; return {}; } };
  await new DevicesApi(api).get("a/b");
  assert.equal(seen, "/devices/a%2Fb");
});
