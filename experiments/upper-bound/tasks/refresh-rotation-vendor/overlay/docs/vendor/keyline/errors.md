# Errors

Errors use the OAuth format:

```json
{ "error": "invalid_grant", "error_description": "…" }
```

| HTTP | `error` | Meaning |
|---|---|---|
| 400 | `invalid_request` | Malformed body or missing field |
| 400 | `invalid_grant` | Credentials, code or refresh token not valid (expired, revoked, already used) |
| 400 | `unsupported_grant_type` | Grant not enabled for this client |
| 400 | `slow_down` | Device-code polling too fast |
| 401 | `invalid_client` | Unknown client or bad secret |
| 422 | `retry_token_mismatch` | See [Request headers](request-headers.md) |
| 429 | `rate_limited` | See [Rate limits](rate-limits.md) |
| 5xx | `server_error` | Retry with backoff |

`error_description` is for humans and may change without notice. Match on
`error` only.
