/** channels: list, fetch, create, update and delete. */
export class ChannelsApi {
  constructor(api) {
    this.api = api;
  }

  list({ cursor, limit = 50 } = {}) {
    const q = new URLSearchParams({ limit: String(limit) });
    if (cursor) q.set("cursor", cursor);
    return this.api.get(`/channels?${q}`);
  }

  get(id) {
    return this.api.get(`/channels/${encodeURIComponent(id)}`);
  }

  create(fields) {
    return this.api.post("/channels", fields);
  }

  update(id, changes) {
    return this.api.post(`/channels/${encodeURIComponent(id)}`, changes, { idempotent: true });
  }

  remove(id) {
    return this.api.post(`/channels/${encodeURIComponent(id)}/delete`, {}, { idempotent: true });
  }
}
