# ADR 0002: Token store interface

Status: accepted (2023-04)

## Decision

All token access goes through a store object with `save`, `clear`,
`accessToken`, `refreshToken` and `signedIn`. The browser build injects
`PersistentTokenStore`; tests and SSR use `TokenStore`.

## Consequences

The UI subscribes to the store. Clearing it is how a sign-out happens.
