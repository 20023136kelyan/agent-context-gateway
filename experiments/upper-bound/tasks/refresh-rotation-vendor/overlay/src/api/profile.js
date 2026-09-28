/** The signed-in user's profile. */
export class ProfileApi {
  constructor(api) {
    this.api = api;
  }

  get() {
    return this.api.get("/me");
  }

  update(changes) {
    const allowed = ["displayName", "locale", "timezone", "avatarUrl"];
    const body = Object.fromEntries(Object.entries(changes).filter(([k]) => allowed.includes(k)));
    return this.api.post("/me", body);
  }
}
