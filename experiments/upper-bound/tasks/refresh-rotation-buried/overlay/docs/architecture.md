# Architecture

Tokenbox's web client talks to two backends:

- **Keyline** (third party) issues and refreshes tokens. Only `src/authClient.js`
  talks to it, through `src/transport.js`.
- **The Tokenbox API** serves everything else. Calls go through `ApiClient`
  (`src/api/apiClient.js`), which wraps each call in `SessionGuard`.

```text
UI ──► ProfileApi / BillingApi / … ──► ApiClient ──► SessionGuard ──► HttpTransport ──► Tokenbox API
                                                          │
                                                          └─ on 401: AuthClient.refreshSession ──► HttpTransport ──► Keyline
```

## Sessions

A session is a pair of tokens in the token store: a short-lived access token
(15 minutes) and a refresh token. `SessionGuard` sends the access token; on a
401 it asks `AuthClient` for a new pair and retries the call once.

Signing out clears the store. The UI listens for the store becoming empty and
shows the sign-in screen, so **anything that clears the store signs the user out**.

## Failure handling

- Transient failures (no response, 5xx, 429) on reads are retried with
  `withRetry` (`src/lib/retry.js`); see ADR 0003.
- Writes are retried only when they are idempotent. Payments always carry a
  Paylane idempotency key (ADR 0004).
- Errors from the auth server are mapped to `AuthError` codes: `invalid_grant`,
  `network`, `server_error`.

## Storage

`TokenStore` keeps tokens in memory (tests, server-side rendering).
`PersistentTokenStore` adds localStorage persistence for the browser.

## Configuration

`src/config.js` reads `TOKENBOX_ENV` and per-service URL overrides.
