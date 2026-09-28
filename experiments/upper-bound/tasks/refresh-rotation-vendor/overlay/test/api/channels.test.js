import { test } from "node:test";
import assert from "node:assert/strict";
import { ChannelsApi } from "../../src/api/channels.js";

test("channels: get encodes the id", async () => {
  let seen;
  const api = { get: async (p) => { seen = p; return {}; } };
  await new ChannelsApi(api).get("a/b");
  assert.equal(seen, "/channels/a%2Fb");
});
