# Passwordless sign-in

Magic links: `POST /passwordless/start` with an email sends a link valid for 10 minutes. The link redirects to your app with a one-time code; exchange it at `/oauth/token` with `grant_type=passwordless`.
