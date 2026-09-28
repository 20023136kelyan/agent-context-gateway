/** files: list, fetch, create, update and delete. */
export class FilesApi {
  constructor(api) {
    this.api = api;
  }

  list({ cursor, limit = 50 } = {}) {
    const q = new URLSearchParams({ limit: String(limit) });
    if (cursor) q.set("cursor", cursor);
    return this.api.get(`/files?${q}`);
  }

  get(id) {
    return this.api.get(`/files/${encodeURIComponent(id)}`);
  }

  create(fields) {
    return this.api.post("/files", fields);
  }

  update(id, changes) {
    return this.api.post(`/files/${encodeURIComponent(id)}`, changes, { idempotent: true });
  }

  remove(id) {
    return this.api.post(`/files/${encodeURIComponent(id)}/delete`, {}, { idempotent: true });
  }
}
