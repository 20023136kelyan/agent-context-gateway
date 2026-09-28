/** Small TTL cache for GET responses. */
export class TtlCache {
  constructor(ttlMs = 30_000) {
    this.ttlMs = ttlMs;
    this.map = new Map();
  }

  get(key) {
    const e = this.map.get(key);
    if (!e || Date.now() - e.at > this.ttlMs) return undefined;
    return e.value;
  }

  set(key, value) {
    this.map.set(key, { value, at: Date.now() });
  }
}
