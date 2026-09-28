/** templates: list, fetch, create, update and delete. */
export class TemplatesApi {
  constructor(api) {
    this.api = api;
  }

  list({ cursor, limit = 50 } = {}) {
    const q = new URLSearchParams({ limit: String(limit) });
    if (cursor) q.set("cursor", cursor);
    return this.api.get(`/templates?${q}`);
  }

  get(id) {
    return this.api.get(`/templates/${encodeURIComponent(id)}`);
  }

  create(fields) {
    return this.api.post("/templates", fields, { idempotent: true });
  }

  update(id, changes) {
    return this.api.post(`/templates/${encodeURIComponent(id)}`, changes, { idempotent: true });
  }

  remove(id) {
    return this.api.post(`/templates/${encodeURIComponent(id)}/delete`, {}, { idempotent: true });
  }
}
