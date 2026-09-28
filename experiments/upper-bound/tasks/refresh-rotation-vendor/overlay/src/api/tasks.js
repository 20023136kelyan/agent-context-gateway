/** tasks: list, fetch, create, update and delete. */
export class TasksApi {
  constructor(api) {
    this.api = api;
  }

  list({ cursor, limit = 50 } = {}) {
    const q = new URLSearchParams({ limit: String(limit) });
    if (cursor) q.set("cursor", cursor);
    return this.api.get(`/tasks?${q}`);
  }

  get(id) {
    return this.api.get(`/tasks/${encodeURIComponent(id)}`);
  }

  create(fields) {
    return this.api.post("/tasks", fields, { idempotent: true });
  }

  update(id, changes) {
    return this.api.post(`/tasks/${encodeURIComponent(id)}`, changes, { idempotent: true });
  }

  remove(id) {
    return this.api.post(`/tasks/${encodeURIComponent(id)}/delete`, {}, { idempotent: true });
  }
}
