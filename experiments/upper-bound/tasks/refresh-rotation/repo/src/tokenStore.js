/** In-memory token storage. The browser build swaps this for a storage-backed one. */
export class TokenStore {
  constructor(initial = {}) {
    this.accessToken = initial.accessToken ?? null;
    this.refreshToken = initial.refreshToken ?? null;
  }

  save({ accessToken, refreshToken }) {
    this.accessToken = accessToken;
    this.refreshToken = refreshToken;
  }

  clear() {
    this.accessToken = null;
    this.refreshToken = null;
  }

  get signedIn() {
    return this.refreshToken !== null;
  }
}
