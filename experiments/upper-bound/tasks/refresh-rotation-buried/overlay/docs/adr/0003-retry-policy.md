# ADR 0003: Retry policy for network calls

Status: accepted (2023-09)

## Context

Mobile users on flaky networks saw errors for requests that would have
succeeded a second later. Each module had its own ad-hoc retry loop.

## Decision

- All transient failures are retried through one helper, `withRetry`
  (`src/lib/retry.js`): up to 3 retries, exponential backoff with jitter.
- Transient means: no response (`TransportError`), 5xx, or 429.
- Reads are always retried. Writes are retried only if the endpoint is
  idempotent; callers opt in with `{ idempotent: true }`.

## Consequences

- One place to tune backoff.
- A non-idempotent write must never be retried blindly; mark it or leave it.
