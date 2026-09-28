/** reactions: list, fetch, create, update and delete. */
export class ReactionsApi {
  constructor(api) {
    this.api = api;
  }

  list({ cursor, limit = 50 } = {}) {
    const q = new URLSearchParams({ limit: String(limit) });
    if (cursor) q.set("cursor", cursor);
    return this.api.get(`/reactions?${q}`);
  }

  get(id) {
    return this.api.get(`/reactions/${encodeURIComponent(id)}`);
  }

  create(fields) {
    return this.api.post("/reactions", fields, { idempotent: true });
  }

  update(id, changes) {
    return this.api.post(`/reactions/${encodeURIComponent(id)}`, changes, { idempotent: true });
  }

  remove(id) {
    return this.api.post(`/reactions/${encodeURIComponent(id)}/delete`, {}, { idempotent: true });
  }
}
