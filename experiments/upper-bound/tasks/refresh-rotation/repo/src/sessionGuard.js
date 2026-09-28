import { AuthError } from "./authClient.js";

/**
 * Runs API calls with the current access token. On a 401 it refreshes the
 * session once and retries the call once.
 */
export class SessionGuard {
  constructor({ auth, store }) {
    this.auth = auth;
    this.store = store;
  }

  /**
   * @param {(accessToken: string) => Promise<{ status: number, body: unknown }>} call
   */
  async run(call) {
    if (!this.store.signedIn) throw new AuthError("invalid_grant", "not signed in");
    let res = await call(this.store.accessToken);
    if (res.status !== 401) return res;
    await this.auth.refreshSession();
    res = await call(this.store.accessToken);
    return res;
  }
}
