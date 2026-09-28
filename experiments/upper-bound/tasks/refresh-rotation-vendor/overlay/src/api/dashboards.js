/** dashboards: list, fetch, create, update and delete. */
export class DashboardsApi {
  constructor(api) {
    this.api = api;
  }

  list({ cursor, limit = 50 } = {}) {
    const q = new URLSearchParams({ limit: String(limit) });
    if (cursor) q.set("cursor", cursor);
    return this.api.get(`/dashboards?${q}`);
  }

  get(id) {
    return this.api.get(`/dashboards/${encodeURIComponent(id)}`);
  }

  create(fields) {
    return this.api.post("/dashboards", fields, { idempotent: true });
  }

  update(id, changes) {
    return this.api.post(`/dashboards/${encodeURIComponent(id)}`, changes, { idempotent: true });
  }

  remove(id) {
    return this.api.post(`/dashboards/${encodeURIComponent(id)}/delete`, {}, { idempotent: true });
  }
}
