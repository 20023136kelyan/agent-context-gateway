/** approvals: list, fetch, create, update and delete. */
export class ApprovalsApi {
  constructor(api) {
    this.api = api;
  }

  list({ cursor, limit = 50 } = {}) {
    const q = new URLSearchParams({ limit: String(limit) });
    if (cursor) q.set("cursor", cursor);
    return this.api.get(`/approvals?${q}`);
  }

  get(id) {
    return this.api.get(`/approvals/${encodeURIComponent(id)}`);
  }

  create(fields) {
    return this.api.post("/approvals", fields);
  }

  update(id, changes) {
    return this.api.post(`/approvals/${encodeURIComponent(id)}`, changes, { idempotent: true });
  }

  remove(id) {
    return this.api.post(`/approvals/${encodeURIComponent(id)}/delete`, {}, { idempotent: true });
  }
}
