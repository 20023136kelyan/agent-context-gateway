import { test } from "node:test";
import assert from "node:assert/strict";
import { formatMoney, toCents } from "../src/index.js";

test("formats cents for display", () => {
  assert.equal(formatMoney(123450), "€1,234.50");
});

test("parses amounts into cents", () => {
  assert.equal(toCents("1234.5"), 123450);
});
