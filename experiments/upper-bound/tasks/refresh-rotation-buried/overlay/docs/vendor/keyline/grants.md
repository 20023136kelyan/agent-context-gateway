# Grants

All grants use `POST /oauth/token`.

## Password grant (legacy)

```json
{ "grant_type": "password", "client_id": "…", "username": "…", "password": "…" }
```

Returns a token pair. Deprecated for new clients since v3.0; existing
first-party clients may keep using it until further notice. Subject to
breached-password checks (see [Security](security.md)).

## Refresh-token grant

```json
{ "grant_type": "refresh_token", "client_id": "…", "refresh_token": "…" }
```

Returns a new token pair (see [Tokens](tokens.md#token-response)). Public
clients must send `client_id`. Scopes cannot be widened on refresh.

## Client-credentials grant

```json
{ "grant_type": "client_credentials", "client_id": "…", "client_secret": "…", "scope": "…" }
```

Returns an access token only. Confidential clients only.

## Device-code grant

For input-constrained devices. `POST /oauth/device` returns a `device_code`
and `user_code`; poll `/oauth/token` with
`{ "grant_type": "urn:ietf:params:oauth:grant-type:device_code", "device_code": "…" }`
no faster than the returned `interval`. Polling faster returns `slow_down`.
