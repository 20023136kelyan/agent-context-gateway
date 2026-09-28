import { TokenStore } from "../tokenStore.js";

const KEY = "tokenbox.session";

/**
 * Token storage backed by a Storage-like object (localStorage in the browser).
 * Same interface as TokenStore.
 */
export class PersistentTokenStore extends TokenStore {
  constructor(storage) {
    let initial = {};
    try {
      initial = JSON.parse(storage.getItem(KEY) ?? "{}");
    } catch {
      initial = {};
    }
    super(initial);
    this.storage = storage;
  }

  save(tokens) {
    super.save(tokens);
    this.storage.setItem(KEY, JSON.stringify({ accessToken: this.accessToken, refreshToken: this.refreshToken }));
  }

  clear() {
    super.clear();
    this.storage.removeItem(KEY);
  }
}
