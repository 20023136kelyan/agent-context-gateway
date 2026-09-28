# Webhooks

Keyline can notify your backend of these events:

| Event | When |
|---|---|
| `session.revoked` | A session ended by sign-out, admin action or security rule |
| `session.suspicious` | Anomaly detection flagged a sign-in |
| `user.locked` | Brute-force protection locked a user |
| `password.changed` | The user changed or reset their password |

Configure endpoints in the console. Payloads are signed with HMAC-SHA256 in the
`keyline-signature` header; reject payloads older than 5 minutes. Deliveries
are retried for 24 hours with backoff.
