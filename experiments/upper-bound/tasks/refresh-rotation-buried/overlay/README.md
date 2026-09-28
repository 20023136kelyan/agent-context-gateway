# tokenbox

Session, API and account handling for the Tokenbox web client.

## Layout

| Path | What it does |
|---|---|
| `src/authClient.js` | Signs in, refreshes tokens, signs out |
| `src/sessionGuard.js` | Runs API calls with a valid access token; refreshes on 401 |
| `src/transport.js` | HTTP transport for the auth server and the API |
| `src/tokenStore.js` | In-memory token storage (tests, server-side rendering) |
| `src/storage/persistentStore.js` | Browser token storage |
| `src/api/` | Typed clients for the Tokenbox API: profile, billing, notifications, uploads, search |
| `src/lib/` | Shared helpers: retries, logging, events, ids |
| `src/config.js` | Environment configuration |
| `src/featureFlags.js` | Remote feature flags |
| `src/telemetry.js` | Client-side metrics |

Architecture notes are in `docs/architecture.md`, decisions in `docs/adr/`,
on-call guides in `docs/runbooks/`.

Third-party services and their API references (copied from the vendors'
portals for offline use):

- **Keyline**: hosted auth server. `docs/vendor/keyline/`
- **Paylane**: payments. `docs/vendor/paylane/`
- **Postbird**: transactional email. `docs/vendor/postbird/`

## Development

Node 20+, no dependencies. Run the tests with `npm test`.
