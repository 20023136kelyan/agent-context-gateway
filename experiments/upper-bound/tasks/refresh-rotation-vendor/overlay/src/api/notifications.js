/** In-app notifications and email preferences. */
export class NotificationsApi {
  constructor(api) {
    this.api = api;
  }

  list({ unreadOnly = false } = {}) {
    return this.api.get(`/notifications${unreadOnly ? "?unread=1" : ""}`);
  }

  markRead(ids) {
    return this.api.post("/notifications/read", { ids }, { idempotent: true });
  }

  preferences() {
    return this.api.get("/notifications/preferences");
  }

  setPreferences(prefs) {
    return this.api.post("/notifications/preferences", prefs, { idempotent: true });
  }
}
