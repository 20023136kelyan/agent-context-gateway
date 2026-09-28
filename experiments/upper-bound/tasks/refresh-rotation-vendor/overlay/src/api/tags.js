/** tags: list, fetch, create, update and delete. */
export class TagsApi {
  constructor(api) {
    this.api = api;
  }

  list({ cursor, limit = 50 } = {}) {
    const q = new URLSearchParams({ limit: String(limit) });
    if (cursor) q.set("cursor", cursor);
    return this.api.get(`/tags?${q}`);
  }

  get(id) {
    return this.api.get(`/tags/${encodeURIComponent(id)}`);
  }

  create(fields) {
    return this.api.post("/tags", fields);
  }

  update(id, changes) {
    return this.api.post(`/tags/${encodeURIComponent(id)}`, changes, { idempotent: true });
  }

  remove(id) {
    return this.api.post(`/tags/${encodeURIComponent(id)}/delete`, {}, { idempotent: true });
  }
}
