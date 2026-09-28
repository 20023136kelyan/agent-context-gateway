import { test } from "node:test";
import assert from "node:assert/strict";
import { WidgetsApi } from "../../src/api/widgets.js";

test("widgets: get encodes the id", async () => {
  let seen;
  const api = { get: async (p) => { seen = p; return {}; } };
  await new WidgetsApi(api).get("a/b");
  assert.equal(seen, "/widgets/a%2Fb");
});
