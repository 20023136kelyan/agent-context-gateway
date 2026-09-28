/** projects: list, fetch, create, update and delete. */
export class ProjectsApi {
  constructor(api) {
    this.api = api;
  }

  list({ cursor, limit = 50 } = {}) {
    const q = new URLSearchParams({ limit: String(limit) });
    if (cursor) q.set("cursor", cursor);
    return this.api.get(`/projects?${q}`);
  }

  get(id) {
    return this.api.get(`/projects/${encodeURIComponent(id)}`);
  }

  create(fields) {
    return this.api.post("/projects", fields);
  }

  update(id, changes) {
    return this.api.post(`/projects/${encodeURIComponent(id)}`, changes, { idempotent: true });
  }

  remove(id) {
    return this.api.post(`/projects/${encodeURIComponent(id)}/delete`, {}, { idempotent: true });
  }
}
