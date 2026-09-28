# Sessions

A session starts at sign-in and ends at sign-out, revocation or expiry. The `sid` claim identifies it across refreshes. List a user's sessions with `GET /admin/users/{id}/sessions`; each entry has the device, IP, user agent and last-seen time.
