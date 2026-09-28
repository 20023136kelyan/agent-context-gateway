import { withRetry } from "../lib/retry.js";
import { newRequestId } from "../lib/ids.js";

export class ApiError extends Error {
  constructor(status, body) {
    super(`API returned ${status}`);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

/**
 * Calls the Tokenbox API through the SessionGuard (valid access token,
 * refresh on 401). Reads are retried on transient failures (ADR 0003);
 * writes are retried only when the caller marks them idempotent.
 */
export class ApiClient {
  constructor({ transport, guard, retries = 2 }) {
    this.transport = transport;
    this.guard = guard;
    this.retries = retries;
  }

  async get(path) {
    return this.#send(path, { method: "GET" }, true);
  }

  async post(path, body, { idempotent = false, headers = {} } = {}) {
    return this.#send(path, { method: "POST", body, headers }, idempotent);
  }

  async #send(path, { body, headers = {} }, retry) {
    const call = () =>
      this.guard.run((accessToken) =>
        this.transport.post(path, body ?? null, {
          headers: { authorization: `Bearer ${accessToken}`, "x-request-id": newRequestId(), ...headers },
        }),
      );
    const res = retry ? await withRetry(call, { retries: this.retries }) : await call();
    if (res.status >= 400) throw new ApiError(res.status, res.body);
    return res.body;
  }
}
