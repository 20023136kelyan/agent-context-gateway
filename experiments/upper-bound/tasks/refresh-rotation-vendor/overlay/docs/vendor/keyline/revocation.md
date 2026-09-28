# Revocation and introspection

`POST /oauth/revoke` with `{ "token": "…", "token_type_hint": "refresh_token" }`
revokes a token and the session it belongs to. Always returns 200, even for
unknown tokens.

`POST /oauth/introspect` (confidential clients only) returns
`{ "active": true|false, "sub": "…", "sid": "…", "exp": … }`.

Admins can revoke all sessions of a user in the console or with
`DELETE /admin/users/{id}/sessions`.
