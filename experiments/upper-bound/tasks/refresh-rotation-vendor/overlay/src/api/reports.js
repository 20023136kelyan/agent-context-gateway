/** reports: list, fetch, create, update and delete. */
export class ReportsApi {
  constructor(api) {
    this.api = api;
  }

  list({ cursor, limit = 50 } = {}) {
    const q = new URLSearchParams({ limit: String(limit) });
    if (cursor) q.set("cursor", cursor);
    return this.api.get(`/reports?${q}`);
  }

  get(id) {
    return this.api.get(`/reports/${encodeURIComponent(id)}`);
  }

  create(fields) {
    return this.api.post("/reports", fields);
  }

  update(id, changes) {
    return this.api.post(`/reports/${encodeURIComponent(id)}`, changes, { idempotent: true });
  }

  remove(id) {
    return this.api.post(`/reports/${encodeURIComponent(id)}/delete`, {}, { idempotent: true });
  }
}
