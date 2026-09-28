/** teams: list, fetch, create, update and delete. */
export class TeamsApi {
  constructor(api) {
    this.api = api;
  }

  list({ cursor, limit = 50 } = {}) {
    const q = new URLSearchParams({ limit: String(limit) });
    if (cursor) q.set("cursor", cursor);
    return this.api.get(`/teams?${q}`);
  }

  get(id) {
    return this.api.get(`/teams/${encodeURIComponent(id)}`);
  }

  create(fields) {
    return this.api.post("/teams", fields, { idempotent: true });
  }

  update(id, changes) {
    return this.api.post(`/teams/${encodeURIComponent(id)}`, changes, { idempotent: true });
  }

  remove(id) {
    return this.api.post(`/teams/${encodeURIComponent(id)}/delete`, {}, { idempotent: true });
  }
}
