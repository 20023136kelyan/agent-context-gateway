# Getting started

1. Create a tenant in the Keyline console and note its base URL
   (`https://auth.keyline.example/tenants/<tenant>`).
2. Register a client. Public clients (browser, mobile) have no secret.
3. Enable the grants the client needs (see [Grants](grants.md)).
4. Configure token lifetimes (see [Tokens](tokens.md)).

All endpoints accept and return JSON over HTTPS. Send
`content-type: application/json`. The sandbox tenant resets nightly.

## Environments

| Environment | Base URL |
|---|---|
| Production | `https://auth.keyline.example/tenants/<tenant>` |
| Sandbox | `https://auth.sandbox.keyline.example/tenants/<tenant>` |

## Your first token

```bash
curl -X POST $BASE/oauth/token -H 'content-type: application/json' \
  -d '{"grant_type":"password","client_id":"…","username":"…","password":"…"}'
```
