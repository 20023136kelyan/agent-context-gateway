import { test } from "node:test";
import assert from "node:assert/strict";
import { createRouter, createStore } from "../src/index.js";
import { invoices } from "./fixtures.js";

test("serves the JSON export", () => {
  const res = createRouter(createStore(invoices)).handle({ method: "GET", path: "/exports/invoices.json" });
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body).length, 3);
});

test("unknown paths are 404", () => {
  assert.equal(createRouter(createStore()).handle({ method: "GET", path: "/nope" }).status, 404);
});
