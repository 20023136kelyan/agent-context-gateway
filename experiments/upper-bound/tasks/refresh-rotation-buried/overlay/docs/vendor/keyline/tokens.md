# Tokens

## Token response

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

## Formats

Access tokens are signed JWTs (ES256). Verify them with the tenant's JWKS at
`/.well-known/jwks.json`. Refresh tokens are opaque strings; do not parse them.

## Claims

| Claim | Meaning |
|---|---|
| `sub` | User id |
| `sid` | Session id, stable across refreshes |
| `scope` | Granted scopes |
| `amr` | Authentication methods used (`pwd`, `otp`, `webauthn`) |

## Lifetimes

| Token | Default lifetime | Configurable |
|---|---|---|
| Access token | 15 minutes | 5–60 minutes |
| Refresh token (idle) | 14 days | 1–90 days |
| Refresh token (absolute) | 90 days | 7–365 days |

An idle refresh token expires when it has not been used for the idle lifetime.
The absolute lifetime counts from the original sign-in and carries over to
refresh tokens issued after it.
