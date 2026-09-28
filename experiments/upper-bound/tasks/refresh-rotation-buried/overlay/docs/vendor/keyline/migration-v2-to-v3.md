# Migrating from v2 to v3

- Endpoints moved under `/tenants/<tenant>`. The old host redirects until 2025.
- `expires_at` in token responses was replaced by `expires_in`.
- Error bodies follow the OAuth format (`error`, `error_description`).
- Refresh tokens gained an absolute lifetime (see [Tokens](tokens.md)).
- The password grant is deprecated for new clients.
- Client secrets are shown once at creation; rotate them in the console.
