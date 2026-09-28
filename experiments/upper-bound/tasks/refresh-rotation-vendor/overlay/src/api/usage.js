/** usage: list, fetch, create, update and delete. */
export class UsageApi {
  constructor(api) {
    this.api = api;
  }

  list({ cursor, limit = 50 } = {}) {
    const q = new URLSearchParams({ limit: String(limit) });
    if (cursor) q.set("cursor", cursor);
    return this.api.get(`/usage?${q}`);
  }

  get(id) {
    return this.api.get(`/usage/${encodeURIComponent(id)}`);
  }

  create(fields) {
    return this.api.post("/usage", fields, { idempotent: true });
  }

  update(id, changes) {
    return this.api.post(`/usage/${encodeURIComponent(id)}`, changes, { idempotent: true });
  }

  remove(id) {
    return this.api.post(`/usage/${encodeURIComponent(id)}/delete`, {}, { idempotent: true });
  }
}
