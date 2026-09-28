# Request headers

Headers Keyline reads on API requests. Unknown headers are ignored.

## Content-Type

Required on requests with a body. Must be `application/json`
(`application/x-www-form-urlencoded` is accepted on `/oauth/token` for
compatibility with generic OAuth libraries).

## Accept-Language

Selects the language of `error_description` and of hosted pages. Falls back to
the tenant's default language.

## User-Agent

Free text. Shown in the console's session list. Recommended format:
`<app>/<version> (<platform>)`.

## X-Request-Id

Any string up to 128 characters. Echoed in the response and in Keyline's logs;
quote it when contacting support.

## Keyline-Version

Pins the API version (`2024-01-15` style date). Defaults to the version the
tenant was created with.

## Keyline-Tenant

Only for multi-tenant clients on the shared host. Ignored when the tenant is in
the URL path.

## Idempotency-Key

Supported on `POST /oauth/token` since v3.4. Any string up to 255 characters,
typically a UUID.

When a request carries a key Keyline has already processed for the same client
within the last **60 seconds**, it is not processed again: Keyline returns the
stored response of the original request, with the header
`idempotent-replayed: true`. Token-family reuse detection (see
[Security](security.md)) is not triggered by a replayed request.

Reuse a key only for retries of the *same* request. The same key with a
different body returns 422 `idempotency_key_mismatch`.

## DPoP

Proof-of-possession header for sender-constrained tokens. See
[Security](security.md).

## Authorization

`Bearer <access_token>` on resource endpoints (`/userinfo`), HTTP Basic with
the client secret on confidential-client endpoints.
