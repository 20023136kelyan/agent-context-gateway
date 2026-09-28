/** threads: list, fetch, create, update and delete. */
export class ThreadsApi {
  constructor(api) {
    this.api = api;
  }

  list({ cursor, limit = 50 } = {}) {
    const q = new URLSearchParams({ limit: String(limit) });
    if (cursor) q.set("cursor", cursor);
    return this.api.get(`/threads?${q}`);
  }

  get(id) {
    return this.api.get(`/threads/${encodeURIComponent(id)}`);
  }

  create(fields) {
    return this.api.post("/threads", fields);
  }

  update(id, changes) {
    return this.api.post(`/threads/${encodeURIComponent(id)}`, changes, { idempotent: true });
  }

  remove(id) {
    return this.api.post(`/threads/${encodeURIComponent(id)}/delete`, {}, { idempotent: true });
  }
}
