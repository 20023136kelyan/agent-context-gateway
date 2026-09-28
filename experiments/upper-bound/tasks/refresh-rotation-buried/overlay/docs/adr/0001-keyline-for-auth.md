# ADR 0001: Use Keyline for authentication

Status: accepted (2023-03)

## Context

We need sign-in, token refresh, password resets and MFA for the web and mobile
clients. Building it ourselves means owning password storage and breach checks.

## Decision

Use Keyline's hosted auth server. The web client uses the password grant for
now (first-party client) and refresh tokens for long sessions.

## Consequences

- Token lifetimes and security features are configured in the Keyline console.
- We keep a copy of Keyline's API reference in `docs/vendor/keyline/`.
- Migrating off the password grant is tracked separately.
