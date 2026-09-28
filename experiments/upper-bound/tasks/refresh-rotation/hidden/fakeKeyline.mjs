/**
 * Faithful stand-in for the Keyline token endpoint, as documented in
 * docs/vendor/authserver-api.md: rotation, family-wide reuse detection (§10.2)
 * and idempotent replay (§11). Supports fault injection that loses either the
 * request (before the server processes it) or the response (after).
 */
const REPLAY_WINDOW_MS = 60_000;

export class TransportLikeError extends Error {
  constructor(code) {
    super(`POST /oauth/token failed: ${code}`);
    this.name = "TransportError";
    this.code = code;
  }
}

export class FakeKeyline {
  constructor({ TransportError } = {}) {
    this.TransportError = TransportError ?? TransportLikeError;
    this.n = 0;
    this.tokens = new Map(); // refresh token -> { family, used }
    this.access = new Map(); // access token -> family
    this.families = new Map(); // family -> { revoked }
    this.idem = new Map(); // key -> { bodyJson, response, at }
    this.calls = [];
    this.faults = []; // "before" | "after"
  }

  dropBefore(times = 1) { for (let i = 0; i < times; i++) this.faults.push("before"); }
  dropAfter(times = 1) { for (let i = 0; i < times; i++) this.faults.push("after"); }

  issue(family) {
    this.n += 1;
    const pair = { access_token: `at-${this.n}`, refresh_token: `rt-${this.n}`, token_type: "Bearer", expires_in: 900 };
    this.tokens.set(pair.refresh_token, { family, used: false });
    this.access.set(pair.access_token, family);
    return pair;
  }

  familyOf(refreshToken) { return this.tokens.get(refreshToken)?.family; }
  isRevoked(family) { return this.families.get(family)?.revoked === true; }
  isValidAccess(token) {
    const family = this.access.get(token);
    return family !== undefined && !this.isRevoked(family);
  }
  isCurrentRefresh(token) {
    const t = this.tokens.get(token);
    return !!t && !t.used && !this.isRevoked(t.family);
  }
  get anyFamilyRevoked() { return [...this.families.values()].some((f) => f.revoked); }
  get refreshCalls() { return this.calls.filter((c) => c.body?.grant_type === "refresh_token").length; }

  process(body, key) {
    const bodyJson = JSON.stringify(body);
    if (key) {
      const prior = this.idem.get(key);
      if (prior && Date.now() - prior.at < REPLAY_WINDOW_MS) {
        if (prior.bodyJson !== bodyJson) return { status: 422, body: { error: "idempotency_key_mismatch" } };
        return { ...prior.response, replayed: true };
      }
    }
    const response = this.handle(body);
    if (key) this.idem.set(key, { bodyJson, response, at: Date.now() });
    return response;
  }

  handle(body) {
    if (body?.grant_type === "password") {
      const family = `fam-${this.families.size + 1}`;
      this.families.set(family, { revoked: false });
      return { status: 200, body: this.issue(family) };
    }
    if (body?.grant_type === "refresh_token") {
      const t = this.tokens.get(body.refresh_token);
      if (!t) return { status: 400, body: { error: "invalid_grant", error_description: "unknown refresh token" } };
      if (this.isRevoked(t.family)) return { status: 400, body: { error: "invalid_grant", error_description: "token family revoked" } };
      if (t.used) {
        this.families.get(t.family).revoked = true;
        return { status: 400, body: { error: "invalid_grant", error_description: "refresh token reuse detected; family revoked" } };
      }
      t.used = true;
      return { status: 200, body: this.issue(t.family) };
    }
    return { status: 400, body: { error: "unsupported_grant_type" } };
  }

  transport() {
    return {
      post: async (path, body, options = {}) => {
        const headerKey = Object.entries(options.headers ?? {}).find(([k]) => k.toLowerCase() === "idempotency-key")?.[1];
        const key = options.idempotencyKey ?? headerKey;
        this.calls.push({ path, body, key });
        const fault = this.faults.shift();
        if (fault === "before") throw new this.TransportError("ETIMEDOUT");
        const res = this.process(body, key);
        if (fault === "after") throw new this.TransportError("ETIMEDOUT");
        const { replayed, ...plain } = res;
        return plain;
      },
    };
  }
}
