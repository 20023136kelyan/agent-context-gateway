/** integrations: list, fetch, create, update and delete. */
export class IntegrationsApi {
  constructor(api) {
    this.api = api;
  }

  list({ cursor, limit = 50 } = {}) {
    const q = new URLSearchParams({ limit: String(limit) });
    if (cursor) q.set("cursor", cursor);
    return this.api.get(`/integrations?${q}`);
  }

  get(id) {
    return this.api.get(`/integrations/${encodeURIComponent(id)}`);
  }

  create(fields) {
    return this.api.post("/integrations", fields);
  }

  update(id, changes) {
    return this.api.post(`/integrations/${encodeURIComponent(id)}`, changes, { idempotent: true });
  }

  remove(id) {
    return this.api.post(`/integrations/${encodeURIComponent(id)}/delete`, {}, { idempotent: true });
  }
}
