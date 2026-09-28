import { test } from "node:test";
import assert from "node:assert/strict";
import { withRetry } from "../src/lib/retry.js";
import { TransportError } from "../src/transport.js";

const noSleep = async () => {};

test("retries transport errors and returns the first success", async () => {
  let n = 0;
  const res = await withRetry(async () => {
    n += 1;
    if (n < 3) throw new TransportError("ECONNRESET");
    return { status: 200, body: "ok" };
  }, { sleep: noSleep });
  assert.equal(res.body, "ok");
  assert.equal(n, 3);
});

test("retries 5xx responses but not 4xx", async () => {
  let n = 0;
  const res = await withRetry(async () => ({ status: ++n === 1 ? 503 : 404 }), { sleep: noSleep });
  assert.equal(res.status, 404);
  assert.equal(n, 2);
});

test("gives up after the configured retries", async () => {
  let n = 0;
  await assert.rejects(withRetry(async () => { n += 1; throw new TransportError("ETIMEDOUT"); }, { retries: 2, sleep: noSleep }));
  assert.equal(n, 3);
});
