# Users API

`GET /admin/users/{id}`, `PATCH /admin/users/{id}`, `DELETE /admin/users/{id}`. Admin endpoints need a client-credentials token with the `admin` scope. Deleting a user revokes all sessions.
