/** mentions: list, fetch, create, update and delete. */
export class MentionsApi {
  constructor(api) {
    this.api = api;
  }

  list({ cursor, limit = 50 } = {}) {
    const q = new URLSearchParams({ limit: String(limit) });
    if (cursor) q.set("cursor", cursor);
    return this.api.get(`/mentions?${q}`);
  }

  get(id) {
    return this.api.get(`/mentions/${encodeURIComponent(id)}`);
  }

  create(fields) {
    return this.api.post("/mentions", fields);
  }

  update(id, changes) {
    return this.api.post(`/mentions/${encodeURIComponent(id)}`, changes, { idempotent: true });
  }

  remove(id) {
    return this.api.post(`/mentions/${encodeURIComponent(id)}/delete`, {}, { idempotent: true });
  }
}
