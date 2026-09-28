/** quotas: list, fetch, create, update and delete. */
export class QuotasApi {
  constructor(api) {
    this.api = api;
  }

  list({ cursor, limit = 50 } = {}) {
    const q = new URLSearchParams({ limit: String(limit) });
    if (cursor) q.set("cursor", cursor);
    return this.api.get(`/quotas?${q}`);
  }

  get(id) {
    return this.api.get(`/quotas/${encodeURIComponent(id)}`);
  }

  create(fields) {
    return this.api.post("/quotas", fields);
  }

  update(id, changes) {
    return this.api.post(`/quotas/${encodeURIComponent(id)}`, changes, { idempotent: true });
  }

  remove(id) {
    return this.api.post(`/quotas/${encodeURIComponent(id)}/delete`, {}, { idempotent: true });
  }
}
