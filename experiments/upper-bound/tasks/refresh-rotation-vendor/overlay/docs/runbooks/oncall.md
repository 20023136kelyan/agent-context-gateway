# On-call runbook

## Triage

1. Check the status pages: Keyline (auth), Paylane (payments), Postbird (email).
2. Check the error dashboard for spikes by `AuthError.code` and API status.
3. Tag the ticket: `auth`, `billing`, `api`, `ui`.

## Common tickets

### "I keep getting logged out"

- Check whether the user's refresh token expired (idle 14 days, absolute 90 days).
- Check Keyline's console for revoked sessions on that user.
- Network-related logouts: the client signs out whenever the store is cleared;
  look for `AuthError` with code `network` in the client logs.

### "I was charged twice"

- Look up both charges in Paylane by customer id. If they share an idempotency
  key, it was a replay and only one charge settled. Otherwise refund one and
  file a bug against billing.

### Emails not arriving

- Check Postbird's suppression list for the address.

## Escalation

Auth incidents: #team-identity. Payments: #team-billing.
