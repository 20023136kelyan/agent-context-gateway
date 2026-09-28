# Audit log

Every admin action and security event is recorded. Export with `GET /admin/audit?since=…` (JSON lines, 1000 per page). Entries are kept for 400 days.
