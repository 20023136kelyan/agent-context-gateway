/** webhooks: list, fetch, create, update and delete. */
export class WebhooksApi {
  constructor(api) {
    this.api = api;
  }

  list({ cursor, limit = 50 } = {}) {
    const q = new URLSearchParams({ limit: String(limit) });
    if (cursor) q.set("cursor", cursor);
    return this.api.get(`/webhooks?${q}`);
  }

  get(id) {
    return this.api.get(`/webhooks/${encodeURIComponent(id)}`);
  }

  create(fields) {
    return this.api.post("/webhooks", fields, { idempotent: true });
  }

  update(id, changes) {
    return this.api.post(`/webhooks/${encodeURIComponent(id)}`, changes, { idempotent: true });
  }

  remove(id) {
    return this.api.post(`/webhooks/${encodeURIComponent(id)}/delete`, {}, { idempotent: true });
  }
}
