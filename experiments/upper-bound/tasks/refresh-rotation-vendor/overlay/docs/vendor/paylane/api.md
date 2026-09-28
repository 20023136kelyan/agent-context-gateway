# Paylane API reference (copy)

Payments processor used by the billing service. Last synced 2024-02.

## Authentication

Secret key in `Authorization: Bearer sk_…`. Never ship it to browsers: the web
client calls our API, which calls Paylane.

## Charges

`POST /v1/charges` with `{ "amount": 1200, "currency": "eur", "customer": "cus_…" }`.

## Idempotent requests

All `POST` requests accept an `Idempotency-Key` header. Paylane stores the
first response for a key for **24 hours** and returns it for any retry with the
same key, so a retried charge is never applied twice. Generate one key per
logical operation and reuse it across retries. A different body with the same
key returns 409.

## Errors

| HTTP | Type | Meaning |
|---|---|---|
| 402 | `card_error` | The card was declined |
| 409 | `idempotency_error` | Key reused with a different body |
| 429 | `rate_limit` | Back off |
| 5xx | `api_error` | Retry with the same idempotency key |

## Webhooks

`charge.succeeded`, `charge.failed`, `invoice.paid`. Signed with
`paylane-signature`.
