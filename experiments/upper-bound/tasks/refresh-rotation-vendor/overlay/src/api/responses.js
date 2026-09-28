/** responses: list, fetch, create, update and delete. */
export class ResponsesApi {
  constructor(api) {
    this.api = api;
  }

  list({ cursor, limit = 50 } = {}) {
    const q = new URLSearchParams({ limit: String(limit) });
    if (cursor) q.set("cursor", cursor);
    return this.api.get(`/responses?${q}`);
  }

  get(id) {
    return this.api.get(`/responses/${encodeURIComponent(id)}`);
  }

  create(fields) {
    return this.api.post("/responses", fields);
  }

  update(id, changes) {
    return this.api.post(`/responses/${encodeURIComponent(id)}`, changes, { idempotent: true });
  }

  remove(id) {
    return this.api.post(`/responses/${encodeURIComponent(id)}/delete`, {}, { idempotent: true });
  }
}
