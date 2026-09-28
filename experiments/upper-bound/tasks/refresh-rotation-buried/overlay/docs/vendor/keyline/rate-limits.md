# Rate limits

| Endpoint | Limit |
|---|---|
| `POST /oauth/token` | 20 per minute per user, 600 per minute per client |
| `POST /oauth/revoke` | 60 per minute per client |
| `GET /userinfo` | 120 per minute per access token |

Exceeding a limit returns 429 `rate_limited` with a `retry-after` header in
seconds. Enterprise tenants can request higher limits.
