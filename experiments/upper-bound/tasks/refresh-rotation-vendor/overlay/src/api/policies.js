/** policies: list, fetch, create, update and delete. */
export class PoliciesApi {
  constructor(api) {
    this.api = api;
  }

  list({ cursor, limit = 50 } = {}) {
    const q = new URLSearchParams({ limit: String(limit) });
    if (cursor) q.set("cursor", cursor);
    return this.api.get(`/policies?${q}`);
  }

  get(id) {
    return this.api.get(`/policies/${encodeURIComponent(id)}`);
  }

  create(fields) {
    return this.api.post("/policies", fields);
  }

  update(id, changes) {
    return this.api.post(`/policies/${encodeURIComponent(id)}`, changes, { idempotent: true });
  }

  remove(id) {
    return this.api.post(`/policies/${encodeURIComponent(id)}/delete`, {}, { idempotent: true });
  }
}
