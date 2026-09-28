/** calendars: list, fetch, create, update and delete. */
export class CalendarsApi {
  constructor(api) {
    this.api = api;
  }

  list({ cursor, limit = 50 } = {}) {
    const q = new URLSearchParams({ limit: String(limit) });
    if (cursor) q.set("cursor", cursor);
    return this.api.get(`/calendars?${q}`);
  }

  get(id) {
    return this.api.get(`/calendars/${encodeURIComponent(id)}`);
  }

  create(fields) {
    return this.api.post("/calendars", fields, { idempotent: true });
  }

  update(id, changes) {
    return this.api.post(`/calendars/${encodeURIComponent(id)}`, changes, { idempotent: true });
  }

  remove(id) {
    return this.api.post(`/calendars/${encodeURIComponent(id)}/delete`, {}, { idempotent: true });
  }
}
