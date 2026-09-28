# Organizations

Tenants can group users into organizations with roles (`owner`, `admin`, `member`). The `org` claim lists the active organization. Switching organizations requires a new token via `POST /oauth/token` with `grant_type=org_switch`.
