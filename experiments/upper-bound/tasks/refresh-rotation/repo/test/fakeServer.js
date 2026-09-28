import { TransportError } from "../src/transport.js";

/**
 * Minimal in-process stand-in for the auth server's token endpoint.
 * Issues a new token pair on every refresh.
 */
export class FakeTokenServer {
  constructor() {
    this.counter = 0;
    this.refreshTokens = new Set();
    this.calls = [];
    this.failNext = null; // "ETIMEDOUT" to simulate a lost request
  }

  issue() {
    this.counter += 1;
    const pair = { access_token: `at-${this.counter}`, refresh_token: `rt-${this.counter}`, token_type: "Bearer", expires_in: 900 };
    this.refreshTokens.add(pair.refresh_token);
    return pair;
  }

  transport() {
    return {
      post: async (path, body, options = {}) => {
        this.calls.push({ path, body, options });
        if (this.failNext) {
          const code = this.failNext;
          this.failNext = null;
          throw new TransportError(code);
        }
        if (body.grant_type === "password") return { status: 200, body: this.issue() };
        if (body.grant_type === "refresh_token") {
          if (!this.refreshTokens.has(body.refresh_token)) return { status: 400, body: { error: "invalid_grant" } };
          return { status: 200, body: this.issue() };
        }
        return { status: 400, body: { error: "unsupported_grant_type" } };
      },
    };
  }
}
