/** domains: list, fetch, create, update and delete. */
export class DomainsApi {
  constructor(api) {
    this.api = api;
  }

  list({ cursor, limit = 50 } = {}) {
    const q = new URLSearchParams({ limit: String(limit) });
    if (cursor) q.set("cursor", cursor);
    return this.api.get(`/domains?${q}`);
  }

  get(id) {
    return this.api.get(`/domains/${encodeURIComponent(id)}`);
  }

  create(fields) {
    return this.api.post("/domains", fields);
  }

  update(id, changes) {
    return this.api.post(`/domains/${encodeURIComponent(id)}`, changes, { idempotent: true });
  }

  remove(id) {
    return this.api.post(`/domains/${encodeURIComponent(id)}/delete`, {}, { idempotent: true });
  }
}
