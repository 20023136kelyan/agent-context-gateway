# tokenbox

Session and token handling for the Tokenbox web client.

- `src/authClient.js`: signs in, refreshes tokens, signs out.
- `src/sessionGuard.js`: runs API calls with a valid access token and refreshes on 401.
- `src/transport.js`: HTTP transport used to talk to the auth server and the API.
- `src/tokenStore.js`: in-memory token storage.

The auth server is a third-party service. Its API reference is in
`docs/vendor/authserver-api.md`.

Run the tests with `npm test` (Node 20+, no dependencies).
