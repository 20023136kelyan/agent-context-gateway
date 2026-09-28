import { test } from "node:test";
import assert from "node:assert/strict";
import { FeatureFlags } from "../src/featureFlags.js";

test("keeps the last flags when a refresh fails", async () => {
  let fail = false;
  const flags = new FeatureFlags({ fetchFlags: async () => { if (fail) throw new Error("down"); return { newNav: true }; } });
  await flags.refresh();
  fail = true;
  await flags.refresh();
  assert.equal(flags.isOn("newNav"), true);
});
