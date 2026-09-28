/** roles: list, fetch, create, update and delete. */
export class RolesApi {
  constructor(api) {
    this.api = api;
  }

  list({ cursor, limit = 50 } = {}) {
    const q = new URLSearchParams({ limit: String(limit) });
    if (cursor) q.set("cursor", cursor);
    return this.api.get(`/roles?${q}`);
  }

  get(id) {
    return this.api.get(`/roles/${encodeURIComponent(id)}`);
  }

  create(fields) {
    return this.api.post("/roles", fields, { idempotent: true });
  }

  update(id, changes) {
    return this.api.post(`/roles/${encodeURIComponent(id)}`, changes, { idempotent: true });
  }

  remove(id) {
    return this.api.post(`/roles/${encodeURIComponent(id)}/delete`, {}, { idempotent: true });
  }
}
