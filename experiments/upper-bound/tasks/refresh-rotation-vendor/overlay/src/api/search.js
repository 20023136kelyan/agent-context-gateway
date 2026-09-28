/** Workspace search. */
export class SearchApi {
  constructor(api) {
    this.api = api;
  }

  query(text, { limit = 20, cursor } = {}) {
    const q = new URLSearchParams({ q: text, limit: String(limit) });
    if (cursor) q.set("cursor", cursor);
    return this.api.get(`/search?${q}`);
  }
}
