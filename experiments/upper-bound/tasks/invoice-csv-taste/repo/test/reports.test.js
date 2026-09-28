import { test } from "node:test";
import assert from "node:assert/strict";
import { createStore, monthlyReport } from "../src/index.js";
import { invoices } from "./fixtures.js";

test("monthly report has a header, one row per invoice and a total", () => {
  const lines = monthlyReport(createStore(invoices), 2026, 3).split("\n");
  assert.equal(lines[0], "Invoice ID,Customer,Date,Total");
  assert.equal(lines.length, 4);
  assert.match(lines[2], /^INV-0008,"Dupont, Martin & Fils",/);
  assert.match(lines[3], /Total,€1,714\.50|Total,"€1,714\.50"/);
});
