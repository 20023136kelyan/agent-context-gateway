/** sso: list, fetch, create, update and delete. */
export class SsoApi {
  constructor(api) {
    this.api = api;
  }

  list({ cursor, limit = 50 } = {}) {
    const q = new URLSearchParams({ limit: String(limit) });
    if (cursor) q.set("cursor", cursor);
    return this.api.get(`/sso?${q}`);
  }

  get(id) {
    return this.api.get(`/sso/${encodeURIComponent(id)}`);
  }

  create(fields) {
    return this.api.post("/sso", fields);
  }

  update(id, changes) {
    return this.api.post(`/sso/${encodeURIComponent(id)}`, changes, { idempotent: true });
  }

  remove(id) {
    return this.api.post(`/sso/${encodeURIComponent(id)}/delete`, {}, { idempotent: true });
  }
}
