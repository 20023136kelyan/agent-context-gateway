/** audit: list, fetch, create, update and delete. */
export class AuditApi {
  constructor(api) {
    this.api = api;
  }

  list({ cursor, limit = 50 } = {}) {
    const q = new URLSearchParams({ limit: String(limit) });
    if (cursor) q.set("cursor", cursor);
    return this.api.get(`/audit?${q}`);
  }

  get(id) {
    return this.api.get(`/audit/${encodeURIComponent(id)}`);
  }

  create(fields) {
    return this.api.post("/audit", fields);
  }

  update(id, changes) {
    return this.api.post(`/audit/${encodeURIComponent(id)}`, changes, { idempotent: true });
  }

  remove(id) {
    return this.api.post(`/audit/${encodeURIComponent(id)}/delete`, {}, { idempotent: true });
  }
}
