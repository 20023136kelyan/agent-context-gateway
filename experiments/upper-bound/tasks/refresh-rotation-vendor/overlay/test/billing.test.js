import { test } from "node:test";
import assert from "node:assert/strict";
import { BillingApi } from "../src/api/billing.js";

test("an upgrade carries an Idempotency-Key and is marked idempotent", async () => {
  const calls = [];
  const api = { post: async (path, body, opts) => { calls.push({ path, body, opts }); return {}; } };
  await new BillingApi(api).upgrade("pro", { key: "upg_1" });
  assert.equal(calls[0].path, "/billing/upgrade");
  assert.equal(calls[0].opts.headers["Idempotency-Key"], "upg_1");
  assert.equal(calls[0].opts.idempotent, true);
});
