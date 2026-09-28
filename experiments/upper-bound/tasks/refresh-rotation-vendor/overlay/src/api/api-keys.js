/** apiKeys: list, fetch, create, update and delete. */
export class ApiKeysApi {
  constructor(api) {
    this.api = api;
  }

  list({ cursor, limit = 50 } = {}) {
    const q = new URLSearchParams({ limit: String(limit) });
    if (cursor) q.set("cursor", cursor);
    return this.api.get(`/api-keys?${q}`);
  }

  get(id) {
    return this.api.get(`/api-keys/${encodeURIComponent(id)}`);
  }

  create(fields) {
    return this.api.post("/api-keys", fields, { idempotent: true });
  }

  update(id, changes) {
    return this.api.post(`/api-keys/${encodeURIComponent(id)}`, changes, { idempotent: true });
  }

  remove(id) {
    return this.api.post(`/api-keys/${encodeURIComponent(id)}/delete`, {}, { idempotent: true });
  }
}
