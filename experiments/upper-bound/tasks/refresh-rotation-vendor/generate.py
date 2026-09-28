#!/usr/bin/env python3
"""
Builds overlay/ for the refresh-rotation-vendor task: the buried variant's repo,
grown to a few hundred files, with Keyline's safe-retry mechanism changed to a
proprietary header (Keyline-Retry-Token) that common practice would not guess.

Run from this directory: python3 generate.py   (deterministic; overwrites overlay/)
"""
import os, shutil, textwrap

HERE = os.path.dirname(os.path.abspath(__file__))
BURIED = os.path.join(HERE, "..", "refresh-rotation-buried", "overlay")
OUT = os.path.join(HERE, "overlay")
shutil.rmtree(OUT, ignore_errors=True)
shutil.copytree(BURIED, OUT)
F = {}

def put(path, text):
    F[path] = textwrap.dedent(text).lstrip("\n")

def edit(path, old, new):
    p = os.path.join(OUT, path)
    s = open(p).read()
    assert old in s, (path, old[:60])
    open(p, "w").write(s.replace(old, new, 1))

# ---- Keyline: the safe retry is a proprietary header ------------------------------
K = "docs/vendor/keyline/"
edit(K + "request-headers.md", """## Idempotency-Key

Supported on `POST /oauth/token` since v3.4. Any string up to 255 characters,
typically a UUID.

When a request carries a key Keyline has already processed for the same client
within the last **60 seconds**, it is not processed again: Keyline returns the
stored response of the original request, with the header
`idempotent-replayed: true`. Token-family reuse detection (see
[Security](security.md)) is not triggered by a replayed request.

Reuse a key only for retries of the *same* request. The same key with a
different body returns 422 `idempotency_key_mismatch`.
""", """## Keyline-Retry-Token

Supported on `POST /oauth/token` since v3.4. Any string up to 255 characters,
typically a UUID.

When a request carries a retry token Keyline has already processed for the same
client within the last **60 seconds**, it is not processed again: Keyline
returns the stored response of the original request, with the header
`keyline-replayed: true`. Token-family reuse detection (see
[Security](security.md)) is not triggered by a replayed request.

Reuse a retry token only for retries of the *same* request. The same token with
a different body returns 422 `retry_token_mismatch`.

Keyline does **not** support the generic `Idempotency-Key` header used by
payment APIs. It is ignored like any other unknown header.
""")
edit(K + "security.md", "See `Idempotency-Key` in\n[Request headers](request-headers.md) for retrying a refresh safely.",
     "See `Keyline-Retry-Token` in\n[Request headers](request-headers.md) for retrying a refresh safely.")
edit(K + "errors.md", "| 422 | `idempotency_key_mismatch` | See [Request headers](request-headers.md) |",
     "| 422 | `retry_token_mismatch` | See [Request headers](request-headers.md) |")
edit(K + "changelog.md", "- **v3.4**: `Idempotency-Key` on the token endpoint. Device-code grant GA.",
     "- **v3.4**: `Keyline-Retry-Token` on the token endpoint. Device-code grant GA.")

keyline_extra = {
    "sessions.md": ("Sessions", "A session starts at sign-in and ends at sign-out, revocation or expiry. The `sid` claim identifies it across refreshes. List a user's sessions with `GET /admin/users/{id}/sessions`; each entry has the device, IP, user agent and last-seen time."),
    "mfa.md": ("Multi-factor authentication", "TOTP and WebAuthn are supported. When MFA is required, the password grant returns `mfa_required` and an `mfa_token`. Complete it at `POST /oauth/mfa` with the code or assertion. Recovery codes are single-use."),
    "passwordless.md": ("Passwordless sign-in", "Magic links: `POST /passwordless/start` with an email sends a link valid for 10 minutes. The link redirects to your app with a one-time code; exchange it at `/oauth/token` with `grant_type=passwordless`."),
    "social-login.md": ("Social login", "Google, Apple and GitHub are available as identity providers. Enable them in the console. Users are linked by verified email; unverified emails create a separate account."),
    "users-api.md": ("Users API", "`GET /admin/users/{id}`, `PATCH /admin/users/{id}`, `DELETE /admin/users/{id}`. Admin endpoints need a client-credentials token with the `admin` scope. Deleting a user revokes all sessions."),
    "organizations.md": ("Organizations", "Tenants can group users into organizations with roles (`owner`, `admin`, `member`). The `org` claim lists the active organization. Switching organizations requires a new token via `POST /oauth/token` with `grant_type=org_switch`."),
    "hosted-pages.md": ("Hosted pages", "Keyline hosts sign-in, sign-up, reset and MFA pages. Customize logo, colors and copy in the console. Custom domains need a CNAME and a verified TLS certificate."),
    "branding.md": ("Branding", "Upload a logo (SVG or PNG, max 200 KB), pick a primary color and a font from the list. Email templates share the branding. Preview changes in the sandbox tenant first."),
    "audit-log.md": ("Audit log", "Every admin action and security event is recorded. Export with `GET /admin/audit?since=…` (JSON lines, 1000 per page). Entries are kept for 400 days."),
    "tenants.md": ("Tenants", "A tenant is an isolated user pool with its own clients, settings and keys. Production and sandbox tenants are separate; users are never shared between them."),
    "clients.md": ("Clients", "Public clients (browser, mobile) have no secret and must use PKCE for authorization-code flows. Confidential clients authenticate with a secret or a private-key JWT."),
    "pkce.md": ("PKCE", "Authorization-code flows from public clients must send `code_challenge` (S256) and later the matching `code_verifier`. Plain challenges are rejected."),
    "jwks.md": ("Signing keys", "Keyline signs access tokens with ES256. Keys rotate every 90 days; the old key stays in `/.well-known/jwks.json` for 14 days after rotation. Cache the JWKS for at most 1 hour."),
    "status-and-sla.md": ("Status and SLA", "Status page: status.keyline.example. The token endpoint has a 99.95% monthly availability target. Maintenance windows are announced 7 days ahead."),
    "support.md": ("Support", "Open tickets in the console. Include the `X-Request-Id` of a failing request. Enterprise plans get a 1-hour response time for severity-1 incidents."),
}
for name, (title, body) in keyline_extra.items():
    put(K + name, f"# {title}\n\n{body}\n")
edit(K + "README.md", "- [Changelog](changelog.md)\n", "".join(f"- [{t}]({n})\n" for n, (t, _) in keyline_extra.items()) + "- [Changelog](changelog.md)\n")

# ---- API resources: many small clients like profile.js ------------------------------
RESOURCES = ["teams", "projects", "invites", "comments", "tags", "exports", "webhooks", "audit", "devices", "apiKeys",
             "integrations", "reports", "calendars", "files", "folders", "tasks", "milestones", "labels", "reactions",
             "mentions", "channels", "messages", "threads", "bookmarks", "templates", "forms", "responses", "dashboards",
             "widgets", "alerts", "schedules", "approvals", "policies", "roles", "domains", "sso", "usage", "quotas"]
def cls(name): return name[0].upper() + name[1:] + "Api"
for i, r in enumerate(RESOURCES):
    path = r.replace("apiKeys", "api-keys")
    idempotent_write = i % 3 == 0
    put(f"src/api/{path}.js", f'''
        /** {r}: list, fetch, create, update and delete. */
        export class {cls(r)} {{
          constructor(api) {{
            this.api = api;
          }}

          list({{ cursor, limit = 50 }} = {{}}) {{
            const q = new URLSearchParams({{ limit: String(limit) }});
            if (cursor) q.set("cursor", cursor);
            return this.api.get(`/{path}?${{q}}`);
          }}

          get(id) {{
            return this.api.get(`/{path}/${{encodeURIComponent(id)}}`);
          }}

          create(fields) {{
            return this.api.post("/{path}", fields{", { idempotent: true }" if idempotent_write else ""});
          }}

          update(id, changes) {{
            return this.api.post(`/{path}/${{encodeURIComponent(id)}}`, changes, {{ idempotent: true }});
          }}

          remove(id) {{
            return this.api.post(`/{path}/${{encodeURIComponent(id)}}/delete`, {{}}, {{ idempotent: true }});
          }}
        }}
    ''')
    if i % 2 == 0:
        put(f"test/api/{path}.test.js", f'''
            import {{ test }} from "node:test";
            import assert from "node:assert/strict";
            import {{ {cls(r)} }} from "../../src/api/{path}.js";

            test("{r}: get encodes the id", async () => {{
              let seen;
              const api = {{ get: async (p) => {{ seen = p; return {{}}; }} }};
              await new {cls(r)}(api).get("a/b");
              assert.equal(seen, "/{path}/a%2Fb");
            }});
        ''')

# ---- UI view models -------------------------------------------------------------------
VIEWS = ["SignInView", "SignUpView", "ResetPasswordView", "ProfileView", "SettingsView", "BillingView", "PlansView",
         "InvoicesView", "TeamView", "InviteView", "ProjectListView", "ProjectView", "TaskBoardView", "TaskView",
         "CommentsView", "SearchView", "NotificationsView", "FilesView", "UploadView", "DashboardView", "ReportsView",
         "AuditView", "SessionsView", "DevicesView", "ApiKeysView", "IntegrationsView", "WebhooksView", "CalendarView",
         "InboxView", "ThreadView", "AdminUsersView", "AdminRolesView", "OnboardingView", "HelpView", "AboutView"]
for v in VIEWS:
    kebab = "".join("-" + c.lower() if c.isupper() else c for c in v).lstrip("-")
    put(f"src/ui/{kebab}.js", f'''
        /**
         * {v}: view model. Holds state for the screen and exposes actions.
         * Rendering lives in the framework layer; this file has no DOM access.
         */
        export class {v} {{
          constructor({{ services, onChange = () => {{}} }}) {{
            this.services = services;
            this.onChange = onChange;
            this.state = {{ loading: false, error: null, data: null }};
          }}

          set(patch) {{
            this.state = {{ ...this.state, ...patch }};
            this.onChange(this.state);
          }}

          async load(loader) {{
            this.set({{ loading: true, error: null }});
            try {{
              this.set({{ loading: false, data: await loader(this.services) }});
            }} catch (err) {{
              this.set({{ loading: false, error: err?.message ?? String(err) }});
            }}
          }}
        }}
    ''')

# ---- lib helpers -------------------------------------------------------------------------
LIB = {
    "debounce": "export function debounce(fn, ms) {\n  let t;\n  return (...args) => {\n    clearTimeout(t);\n    t = setTimeout(() => fn(...args), ms);\n  };\n}\n",
    "throttle": "export function throttle(fn, ms) {\n  let last = 0;\n  return (...args) => {\n    const now = Date.now();\n    if (now - last >= ms) {\n      last = now;\n      return fn(...args);\n    }\n  };\n}\n",
    "cache": "/** Small TTL cache for GET responses. */\nexport class TtlCache {\n  constructor(ttlMs = 30_000) {\n    this.ttlMs = ttlMs;\n    this.map = new Map();\n  }\n\n  get(key) {\n    const e = this.map.get(key);\n    if (!e || Date.now() - e.at > this.ttlMs) return undefined;\n    return e.value;\n  }\n\n  set(key, value) {\n    this.map.set(key, { value, at: Date.now() });\n  }\n}\n",
    "format": "export const formatMoney = (cents, currency = \"EUR\", locale = \"en\") =>\n  new Intl.NumberFormat(locale, { style: \"currency\", currency }).format(cents / 100);\n\nexport const formatDate = (iso, locale = \"en\") => new Date(iso).toLocaleDateString(locale);\n",
    "validate": "export const isEmail = (s) => /^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(s);\nexport const isSlug = (s) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s);\n",
    "queue": "/** Runs async jobs one at a time, in order. */\nexport class SerialQueue {\n  constructor() {\n    this.tail = Promise.resolve();\n  }\n\n  push(job) {\n    const run = this.tail.then(job, job);\n    this.tail = run.catch(() => {});\n    return run;\n  }\n}\n",
    "backoff": "/** Delay for attempt n (0-based): exponential with full jitter. Used by retry.js. */\nexport const fullJitter = (n, base = 100, max = 2000) => Math.random() * Math.min(max, base * 2 ** n);\n",
    "clock": "export const now = () => Date.now();\nexport const sleep = (ms) => new Promise((r) => setTimeout(r, ms));\n",
    "url": "export const join = (base, path) => base.replace(/\\/$/, \"\") + \"/\" + path.replace(/^\\//, \"\");\n",
    "i18n": "const catalogs = { en: {}, fr: {}, de: {} };\nexport const t = (locale, key) => catalogs[locale]?.[key] ?? key;\n",
}
for n, c in LIB.items():
    F[f"src/lib/{n}.js"] = c

# ---- docs: ADRs, guides, runbooks ---------------------------------------------------------
ADRS = [
    ("0005-view-models", "View models without DOM access", "Screens keep state in plain view-model classes under src/ui/ so they can be tested without a browser."),
    ("0006-cursor-pagination", "Cursor pagination", "All list endpoints return a `next` cursor. Offsets are not supported."),
    ("0007-feature-flags", "Remote feature flags", "Flags are fetched every 5 minutes and default to off. See src/featureFlags.js."),
    ("0008-telemetry", "Client telemetry", "Counters only, no personal data, flushed in batches of 50."),
    ("0009-uploads", "Direct uploads", "Files go straight to object storage through pre-signed URLs; the API never proxies bytes."),
    ("0010-i18n", "Localization", "English, French and German. Keys fall back to the key itself."),
    ("0011-error-reporting", "Error reporting", "Unhandled errors are reported with the X-Request-Id of the failing call."),
    ("0012-session-timeout", "Idle session timeout", "The UI locks after 30 minutes idle but keeps the tokens; unlocking does not require a refresh."),
]
for slug, title, body in ADRS:
    put(f"docs/adr/{slug}.md", f"# ADR {slug[:4]}: {title}\n\nStatus: accepted\n\n## Decision\n\n{body}\n")
GUIDES = {
    "local-setup": "Install Node 20, run `npm test`. Set TOKENBOX_ENV=development to use the local mock servers.",
    "adding-an-api-client": "Copy one of src/api/*.js, register it in src/index.js, add a test under test/api/.",
    "adding-a-view": "Create a view model in src/ui/, keep it free of DOM access, and test it with a fake services object.",
    "releasing": "Tag the release, let CI build, then promote the staging build to production in the deploy console.",
    "code-style": "Two-space indent, double quotes, no default exports, small modules.",
    "testing": "Unit tests use node:test. Integration tests against staging run nightly in CI.",
    "security-review": "Changes touching auth, billing or uploads need a second reviewer from the identity or billing team.",
    "incident-process": "Declare in #incidents, assign a lead, write a timeline, and file a post-incident review within 5 days.",
}
for slug, body in GUIDES.items():
    put(f"docs/guides/{slug}.md", f"# {slug.replace('-', ' ').capitalize()}\n\n{body}\n")
RUNBOOKS = {
    "billing-failures": "Check Paylane's status page. Retried charges are safe: they carry an Idempotency-Key.",
    "upload-errors": "Pre-signed URLs expire after 15 minutes. Large files over slow links can outlive them.",
    "search-latency": "The search index rebuilds nightly at 02:00 UTC; queries are slower during the rebuild.",
    "email-bounces": "Look up the address in Postbird's suppression list.",
    "feature-flag-rollback": "Set the flag to off in the flags console; clients pick it up within 5 minutes.",
}
for slug, body in RUNBOOKS.items():
    put(f"docs/runbooks/{slug}.md", f"# Runbook: {slug.replace('-', ' ')}\n\n{body}\n")

for path, text in F.items():
    full = os.path.join(OUT, path)
    os.makedirs(os.path.dirname(full), exist_ok=True)
    open(full, "w").write(text)
count = sum(len(fs) for _, _, fs in os.walk(OUT))
print(f"overlay/: {count} files")
