/** forms: list, fetch, create, update and delete. */
export class FormsApi {
  constructor(api) {
    this.api = api;
  }

  list({ cursor, limit = 50 } = {}) {
    const q = new URLSearchParams({ limit: String(limit) });
    if (cursor) q.set("cursor", cursor);
    return this.api.get(`/forms?${q}`);
  }

  get(id) {
    return this.api.get(`/forms/${encodeURIComponent(id)}`);
  }

  create(fields) {
    return this.api.post("/forms", fields);
  }

  update(id, changes) {
    return this.api.post(`/forms/${encodeURIComponent(id)}`, changes, { idempotent: true });
  }

  remove(id) {
    return this.api.post(`/forms/${encodeURIComponent(id)}/delete`, {}, { idempotent: true });
  }
}
