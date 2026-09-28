/** devices: list, fetch, create, update and delete. */
export class DevicesApi {
  constructor(api) {
    this.api = api;
  }

  list({ cursor, limit = 50 } = {}) {
    const q = new URLSearchParams({ limit: String(limit) });
    if (cursor) q.set("cursor", cursor);
    return this.api.get(`/devices?${q}`);
  }

  get(id) {
    return this.api.get(`/devices/${encodeURIComponent(id)}`);
  }

  create(fields) {
    return this.api.post("/devices", fields);
  }

  update(id, changes) {
    return this.api.post(`/devices/${encodeURIComponent(id)}`, changes, { idempotent: true });
  }

  remove(id) {
    return this.api.post(`/devices/${encodeURIComponent(id)}/delete`, {}, { idempotent: true });
  }
}
