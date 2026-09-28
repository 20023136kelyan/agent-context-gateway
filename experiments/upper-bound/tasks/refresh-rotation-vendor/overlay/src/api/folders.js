/** folders: list, fetch, create, update and delete. */
export class FoldersApi {
  constructor(api) {
    this.api = api;
  }

  list({ cursor, limit = 50 } = {}) {
    const q = new URLSearchParams({ limit: String(limit) });
    if (cursor) q.set("cursor", cursor);
    return this.api.get(`/folders?${q}`);
  }

  get(id) {
    return this.api.get(`/folders/${encodeURIComponent(id)}`);
  }

  create(fields) {
    return this.api.post("/folders", fields);
  }

  update(id, changes) {
    return this.api.post(`/folders/${encodeURIComponent(id)}`, changes, { idempotent: true });
  }

  remove(id) {
    return this.api.post(`/folders/${encodeURIComponent(id)}/delete`, {}, { idempotent: true });
  }
}
