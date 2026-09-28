import { test } from "node:test";
import assert from "node:assert/strict";
import { ProfileApi } from "../src/api/profile.js";

test("update drops fields that are not editable", async () => {
  let sent;
  const api = { post: async (_p, body) => { sent = body; return body; } };
  await new ProfileApi(api).update({ displayName: "Ada", email: "x@y", locale: "en" });
  assert.deepEqual(sent, { displayName: "Ada", locale: "en" });
});
