# Security

## Breached-password checks

Password-grant sign-ins are checked against known breached passwords. A match
returns `invalid_grant` with `error_description: "password_breached"`. Tenants
can switch this to warn-only in the console.

## Brute-force protection

After 10 failed sign-ins for a user within 15 minutes, further attempts return
`invalid_grant` for 15 minutes, regardless of the password. Failed attempts
from the same IP across many users are rate-limited separately.

## Multi-factor authentication

Tenants can require a second factor (TOTP or WebAuthn) per client. The password
grant then returns `mfa_required` with an `mfa_token` to complete at
`/oauth/mfa`.

## Session limits

Tenants can cap concurrent sessions per user (default: unlimited). When the
cap is reached, the oldest session is revoked on the next sign-in.

## Token families

All refresh tokens descending from one sign-in form a **family**. Every
successful refresh-token grant rotates the refresh token: the response carries
a new one, and the one presented becomes used.

If a used refresh token is presented again, Keyline treats it as a stolen
token being replayed and **revokes the entire family**: the presented token,
the current refresh token, and every access token issued from the family. The
request fails with `invalid_grant`, and every device signed in through that
family is signed out. Enabled for all tenants since v3.2.

This also applies when the client never received the response that carried
the new refresh token, for example after a timeout. See `Idempotency-Key` in
[Request headers](request-headers.md) for retrying a refresh safely.

## Sender-constrained tokens (DPoP)

Clients enrolled in DPoP must send a `DPoP` proof header with each token
request and resource call. Not enabled for public web clients by default.

## IP allowlists

Confidential clients can be restricted to IP ranges in the console. Requests
from other addresses return 401 `invalid_client`.

## Anomaly detection

Sign-ins from a new country or device can trigger an email to the user and a
`session.suspicious` webhook. No effect on token issuance.
