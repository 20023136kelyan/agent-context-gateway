/** widgets: list, fetch, create, update and delete. */
export class WidgetsApi {
  constructor(api) {
    this.api = api;
  }

  list({ cursor, limit = 50 } = {}) {
    const q = new URLSearchParams({ limit: String(limit) });
    if (cursor) q.set("cursor", cursor);
    return this.api.get(`/widgets?${q}`);
  }

  get(id) {
    return this.api.get(`/widgets/${encodeURIComponent(id)}`);
  }

  create(fields) {
    return this.api.post("/widgets", fields);
  }

  update(id, changes) {
    return this.api.post(`/widgets/${encodeURIComponent(id)}`, changes, { idempotent: true });
  }

  remove(id) {
    return this.api.post(`/widgets/${encodeURIComponent(id)}/delete`, {}, { idempotent: true });
  }
}
