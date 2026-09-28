/** bookmarks: list, fetch, create, update and delete. */
export class BookmarksApi {
  constructor(api) {
    this.api = api;
  }

  list({ cursor, limit = 50 } = {}) {
    const q = new URLSearchParams({ limit: String(limit) });
    if (cursor) q.set("cursor", cursor);
    return this.api.get(`/bookmarks?${q}`);
  }

  get(id) {
    return this.api.get(`/bookmarks/${encodeURIComponent(id)}`);
  }

  create(fields) {
    return this.api.post("/bookmarks", fields);
  }

  update(id, changes) {
    return this.api.post(`/bookmarks/${encodeURIComponent(id)}`, changes, { idempotent: true });
  }

  remove(id) {
    return this.api.post(`/bookmarks/${encodeURIComponent(id)}/delete`, {}, { idempotent: true });
  }
}
