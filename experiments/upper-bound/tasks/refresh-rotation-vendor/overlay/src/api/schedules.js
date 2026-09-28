/** schedules: list, fetch, create, update and delete. */
export class SchedulesApi {
  constructor(api) {
    this.api = api;
  }

  list({ cursor, limit = 50 } = {}) {
    const q = new URLSearchParams({ limit: String(limit) });
    if (cursor) q.set("cursor", cursor);
    return this.api.get(`/schedules?${q}`);
  }

  get(id) {
    return this.api.get(`/schedules/${encodeURIComponent(id)}`);
  }

  create(fields) {
    return this.api.post("/schedules", fields, { idempotent: true });
  }

  update(id, changes) {
    return this.api.post(`/schedules/${encodeURIComponent(id)}`, changes, { idempotent: true });
  }

  remove(id) {
    return this.api.post(`/schedules/${encodeURIComponent(id)}/delete`, {}, { idempotent: true });
  }
}
