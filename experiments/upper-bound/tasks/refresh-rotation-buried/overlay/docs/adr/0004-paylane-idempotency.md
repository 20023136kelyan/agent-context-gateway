# ADR 0004: Idempotency keys for payments

Status: accepted (2024-02)

## Context

A retried upgrade charged a customer twice (incident 2024-01-19).

## Decision

Every Paylane charge carries an `Idempotency-Key`, generated once per logical
payment and reused across retries (`newPaymentKey` in `src/lib/ids.js`).
Paylane replays the first response for 24 hours.

## Consequences

Billing writes can be marked idempotent and retried through `ApiClient`.
