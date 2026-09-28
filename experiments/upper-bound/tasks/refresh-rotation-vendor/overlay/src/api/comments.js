/** comments: list, fetch, create, update and delete. */
export class CommentsApi {
  constructor(api) {
    this.api = api;
  }

  list({ cursor, limit = 50 } = {}) {
    const q = new URLSearchParams({ limit: String(limit) });
    if (cursor) q.set("cursor", cursor);
    return this.api.get(`/comments?${q}`);
  }

  get(id) {
    return this.api.get(`/comments/${encodeURIComponent(id)}`);
  }

  create(fields) {
    return this.api.post("/comments", fields, { idempotent: true });
  }

  update(id, changes) {
    return this.api.post(`/comments/${encodeURIComponent(id)}`, changes, { idempotent: true });
  }

  remove(id) {
    return this.api.post(`/comments/${encodeURIComponent(id)}/delete`, {}, { idempotent: true });
  }
}
