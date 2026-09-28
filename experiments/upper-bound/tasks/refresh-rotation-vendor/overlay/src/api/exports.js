/** exports: list, fetch, create, update and delete. */
export class ExportsApi {
  constructor(api) {
    this.api = api;
  }

  list({ cursor, limit = 50 } = {}) {
    const q = new URLSearchParams({ limit: String(limit) });
    if (cursor) q.set("cursor", cursor);
    return this.api.get(`/exports?${q}`);
  }

  get(id) {
    return this.api.get(`/exports/${encodeURIComponent(id)}`);
  }

  create(fields) {
    return this.api.post("/exports", fields);
  }

  update(id, changes) {
    return this.api.post(`/exports/${encodeURIComponent(id)}`, changes, { idempotent: true });
  }

  remove(id) {
    return this.api.post(`/exports/${encodeURIComponent(id)}/delete`, {}, { idempotent: true });
  }
}
