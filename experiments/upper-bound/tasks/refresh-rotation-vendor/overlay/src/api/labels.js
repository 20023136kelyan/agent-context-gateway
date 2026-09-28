/** labels: list, fetch, create, update and delete. */
export class LabelsApi {
  constructor(api) {
    this.api = api;
  }

  list({ cursor, limit = 50 } = {}) {
    const q = new URLSearchParams({ limit: String(limit) });
    if (cursor) q.set("cursor", cursor);
    return this.api.get(`/labels?${q}`);
  }

  get(id) {
    return this.api.get(`/labels/${encodeURIComponent(id)}`);
  }

  create(fields) {
    return this.api.post("/labels", fields);
  }

  update(id, changes) {
    return this.api.post(`/labels/${encodeURIComponent(id)}`, changes, { idempotent: true });
  }

  remove(id) {
    return this.api.post(`/labels/${encodeURIComponent(id)}/delete`, {}, { idempotent: true });
  }
}
