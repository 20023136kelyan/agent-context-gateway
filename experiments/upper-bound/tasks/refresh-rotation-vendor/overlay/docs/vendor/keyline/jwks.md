# Signing keys

Keyline signs access tokens with ES256. Keys rotate every 90 days; the old key stays in `/.well-known/jwks.json` for 14 days after rotation. Cache the JWKS for at most 1 hour.
