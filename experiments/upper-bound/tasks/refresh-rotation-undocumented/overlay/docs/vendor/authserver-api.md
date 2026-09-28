# Keyline Auth Server: API reference (v3.1)

This is the vendor's reference for the Keyline hosted auth server, copied here
for offline use. The source of truth is the vendor's documentation portal.

Contents:

1. Overview
2. Base URLs and environments
3. Client registration
4. The token endpoint
5. Token lifetimes
6. Revocation and introspection
7. User info
8. Errors
9. Rate limits
10. Security features
11. Webhooks
12. Changelog

---

## 1. Overview

Keyline issues OAuth 2.1 access tokens and refresh tokens for first-party web,
mobile and server clients. All endpoints accept and return JSON over HTTPS.
Requests must include `content-type: application/json`.

## 2. Base URLs and environments

| Environment | Base URL |
|---|---|
| Production | `https://auth.keyline.example` |
| Sandbox | `https://sandbox.auth.keyline.example` |

The sandbox resets every Sunday at 00:00 UTC. Tokens issued in the sandbox are
not valid in production.

## 3. Client registration

Each client has a `client_id`. Public clients (browser and mobile apps) have no
secret and must use PKCE for the authorization-code grant. Confidential clients
authenticate with `client_secret` in the request body or with HTTP Basic.

Allowed grant types are configured per client in the Keyline console:
`authorization_code`, `password` (legacy, first-party only), `refresh_token`,
`client_credentials`.

## 4. The token endpoint

`POST /oauth/token`

### 4.1 Password grant (legacy)

```json
{ "grant_type": "password", "client_id": "…", "username": "…", "password": "…" }
```

Returns a token pair (§4.4). Deprecated for new clients; existing first-party
clients may keep using it until further notice.

### 4.2 Refresh-token grant

```json
{ "grant_type": "refresh_token", "client_id": "…", "refresh_token": "…" }
```

Returns a new token pair (§4.4). See §5 for lifetimes.

### 4.3 Client-credentials grant

```json
{ "grant_type": "client_credentials", "client_id": "…", "client_secret": "…", "scope": "…" }
```

Returns an access token only.

### 4.4 Token response

```json
{
  "access_token": "…",
  "refresh_token": "…",
  "token_type": "Bearer",
  "expires_in": 900,
  "scope": "openid profile"
}
```

`expires_in` is the access-token lifetime in seconds.

## 5. Token lifetimes

| Token | Default lifetime | Configurable |
|---|---|---|
| Access token | 15 minutes | 5–60 minutes |
| Refresh token (idle) | 14 days | 1–90 days |
| Refresh token (absolute) | 90 days | 7–365 days |

An idle refresh token expires when it has not been used for the idle lifetime.
The absolute lifetime counts from the original sign-in and is carried over to
every refresh token issued after it.

## 6. Revocation and introspection

`POST /oauth/revoke` with `{ "token": "…", "token_type_hint": "refresh_token" }`
revokes a token.
Always returns 200, even for unknown tokens.

`POST /oauth/introspect` (confidential clients only) returns
`{ "active": true|false, … }`.

## 7. User info

`GET /userinfo` with `Authorization: Bearer <access_token>` returns the
signed-in user's profile claims.

## 8. Errors

Errors use the OAuth format:

```json
{ "error": "invalid_grant", "error_description": "…" }
```

| HTTP | `error` | Meaning |
|---|---|---|
| 400 | `invalid_request` | Malformed body or missing field |
| 400 | `invalid_grant` | Credentials, code or refresh token not valid (expired, revoked, already used) |
| 400 | `unsupported_grant_type` | Grant not enabled for this client |
| 401 | `invalid_client` | Unknown client or bad secret |
| 429 | `rate_limited` | See §9 |
| 5xx | `server_error` | Retry with backoff |

## 9. Rate limits

The token endpoint allows 20 requests per minute per user and
600 per minute per client. Exceeding either returns 429 with a `retry-after`
header in seconds.

## 10. Security features

### 10.1 Breached-password checks

Password-grant sign-ins are checked against known breached passwords. A match
returns `invalid_grant` with `error_description: "password_breached"`.

### 10.2 Sender-constrained tokens

Clients enrolled in DPoP must send a `DPoP` proof header. Not enabled for
public web clients by default.

## 11. Webhooks

Keyline can notify your backend of `session.revoked`, `user.locked` and
`password.changed` events. Configure endpoints in the console. Payloads are
signed with HMAC-SHA256 in the `keyline-signature` header.

## 12. Changelog

- **v3.1**: Webhooks for `session.revoked`, `user.locked` and `password.changed`.
- **v3.0**: Absolute refresh-token lifetime. Password grant deprecated for new clients.
