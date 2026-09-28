/** alerts: list, fetch, create, update and delete. */
export class AlertsApi {
  constructor(api) {
    this.api = api;
  }

  list({ cursor, limit = 50 } = {}) {
    const q = new URLSearchParams({ limit: String(limit) });
    if (cursor) q.set("cursor", cursor);
    return this.api.get(`/alerts?${q}`);
  }

  get(id) {
    return this.api.get(`/alerts/${encodeURIComponent(id)}`);
  }

  create(fields) {
    return this.api.post("/alerts", fields);
  }

  update(id, changes) {
    return this.api.post(`/alerts/${encodeURIComponent(id)}`, changes, { idempotent: true });
  }

  remove(id) {
    return this.api.post(`/alerts/${encodeURIComponent(id)}/delete`, {}, { idempotent: true });
  }
}
