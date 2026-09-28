import { randomUUID } from "node:crypto";

/** Request ids for tracing (X-Request-Id). */
export function newRequestId() {
  return randomUUID();
}

/** Keys for Paylane's Idempotency-Key header; one per logical payment. */
export function newPaymentKey(prefix = "pay") {
  return `${prefix}_${randomUUID()}`;
}
