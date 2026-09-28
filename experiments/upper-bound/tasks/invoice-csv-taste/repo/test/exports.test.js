import { test } from "node:test";
import assert from "node:assert/strict";
import { exportInvoicesJson } from "../src/index.js";
import { invoices } from "./fixtures.js";

test("JSON export lists every invoice", () => {
  const out = JSON.parse(exportInvoicesJson(invoices));
  assert.equal(out.length, 3);
  assert.deepEqual(out[1], { invoiceId: "INV-0008", customerName: "Dupont, Martin & Fils", issuedAt: "2026-03-14T16:40:00Z", total: "€1,234.50" });
});
