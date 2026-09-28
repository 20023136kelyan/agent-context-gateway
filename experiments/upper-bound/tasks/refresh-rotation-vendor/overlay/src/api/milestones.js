/** milestones: list, fetch, create, update and delete. */
export class MilestonesApi {
  constructor(api) {
    this.api = api;
  }

  list({ cursor, limit = 50 } = {}) {
    const q = new URLSearchParams({ limit: String(limit) });
    if (cursor) q.set("cursor", cursor);
    return this.api.get(`/milestones?${q}`);
  }

  get(id) {
    return this.api.get(`/milestones/${encodeURIComponent(id)}`);
  }

  create(fields) {
    return this.api.post("/milestones", fields);
  }

  update(id, changes) {
    return this.api.post(`/milestones/${encodeURIComponent(id)}`, changes, { idempotent: true });
  }

  remove(id) {
    return this.api.post(`/milestones/${encodeURIComponent(id)}/delete`, {}, { idempotent: true });
  }
}
