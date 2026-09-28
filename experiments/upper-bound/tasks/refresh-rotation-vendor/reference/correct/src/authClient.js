import { randomUUID } from "node:crypto";
import { TransportError } from "./transport.js";

export class AuthError extends Error {
  constructor(code, message) {
    super(message ?? code);
    this.name = "AuthError";
    this.code = code; // "invalid_grant" | "network" | "server_error"
  }
}

/**
 * Talks to the auth server's token endpoint and keeps the token store current.
 */
export class AuthClient {
  /**
   * @param {{ transport: { post: Function }, store: import("./tokenStore.js").TokenStore, clientId?: string }} deps
   */
  constructor({ transport, store, clientId = "tokenbox-web" }) {
    this.transport = transport;
    this.store = store;
    this.clientId = clientId;
  }

  async signIn(username, password) {
    const res = await this.transport.post("/oauth/token", {
      grant_type: "password",
      client_id: this.clientId,
      username,
      password,
    });
    if (res.status !== 200) throw new AuthError(res.body?.error ?? "server_error");
    this.store.save({ accessToken: res.body.access_token, refreshToken: res.body.refresh_token });
  }

  /**
   * Exchanges the stored refresh token for a new access token.
   * Signs the user out when the refresh token is rejected.
   */
  async refreshSession() {
    const refreshToken = this.store.refreshToken;
    if (!refreshToken) throw new AuthError("invalid_grant", "not signed in");

    // Keyline rotates refresh tokens and revokes the whole family when a used
    // one is presented again (docs/vendor/keyline/security.md, "Token families"). A timeout
    // can land after the server rotated, so every retry of this refresh must
    // carry the same Keyline-Retry-Token (Keyline ignores Idempotency-Key); the server then replays its first
    // response instead of treating the retry as reuse (request-headers.md).
    const idempotencyKey = randomUUID();
    const attempts = 3;
    let res;
    for (let attempt = 1; ; attempt++) {
      try {
        res = await this.transport.post(
          "/oauth/token",
          { grant_type: "refresh_token", client_id: this.clientId, refresh_token: refreshToken },
          { headers: { "Keyline-Retry-Token": idempotencyKey } },
        );
        break;
      } catch (err) {
        if (!(err instanceof TransportError)) throw err;
        // Keep the session: a network failure says nothing about the token.
        if (attempt >= attempts) throw new AuthError("network", err.message);
        await new Promise((r) => setTimeout(r, 50 * 2 ** attempt));
      }
    }

    if (res.status === 200) {
      this.store.save({ accessToken: res.body.access_token, refreshToken: res.body.refresh_token });
      return res.body.access_token;
    }
    if (res.status === 400 && res.body?.error === "invalid_grant") {
      this.store.clear();
      throw new AuthError("invalid_grant", "refresh token rejected");
    }
    throw new AuthError("server_error", `token endpoint returned ${res.status}`);
  }

  signOut() {
    this.store.clear();
  }
}
