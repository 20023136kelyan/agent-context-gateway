/** messages: list, fetch, create, update and delete. */
export class MessagesApi {
  constructor(api) {
    this.api = api;
  }

  list({ cursor, limit = 50 } = {}) {
    const q = new URLSearchParams({ limit: String(limit) });
    if (cursor) q.set("cursor", cursor);
    return this.api.get(`/messages?${q}`);
  }

  get(id) {
    return this.api.get(`/messages/${encodeURIComponent(id)}`);
  }

  create(fields) {
    return this.api.post("/messages", fields, { idempotent: true });
  }

  update(id, changes) {
    return this.api.post(`/messages/${encodeURIComponent(id)}`, changes, { idempotent: true });
  }

  remove(id) {
    return this.api.post(`/messages/${encodeURIComponent(id)}/delete`, {}, { idempotent: true });
  }
}
