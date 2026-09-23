/**
 * Key proxy accounts: who may call, on which plan, and what they have used.
 *
 * API keys are shown once, at creation, and stored only as SHA-256 hashes,
 * so a copy of this database cannot be replayed against the proxy. Usage is
 * kept per user, per calendar month (UTC), per route, with cost in integer
 * micro-dollars so repeated additions never drift.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Plan = "free" | "paid";

export interface ProxyUser {
  id: string;
  email: string;
  plan: Plan;
  createdAt: string;
}

export interface MonthUsage {
  month: string;
  requests: number;
  tokens: number;
  microUsd: number;
  byRoute: Record<string, { requests: number; tokens: number; microUsd: number }>;
}

// node:sqlite is experimental and Vitest's transform strips static `node:`
// imports: load it lazily, as the other SQLite stores do.
const require = createRequire(import.meta.url);
type DatabaseSyncType = typeof import("node:sqlite")["DatabaseSync"];
function loadDatabaseSync(): DatabaseSyncType {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return (require("node:sqlite") as typeof import("node:sqlite")).DatabaseSync;
}

export const KEY_PREFIX = "acgp_";
const hashKey = (key: string) => createHash("sha256").update(key).digest("hex");
export const monthOf = (d: Date = new Date()) => d.toISOString().slice(0, 7);

export class ProxyStore {
  private db: InstanceType<DatabaseSyncType>;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    const DatabaseSync = loadDatabaseSync();
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, plan TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS api_keys (
        hash TEXT PRIMARY KEY, prefix TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id),
        created_at TEXT NOT NULL, revoked_at TEXT
      );
      CREATE TABLE IF NOT EXISTS usage (
        user_id TEXT NOT NULL, month TEXT NOT NULL, route TEXT NOT NULL,
        requests INTEGER NOT NULL DEFAULT 0, tokens INTEGER NOT NULL DEFAULT 0, micro_usd INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id, month, route)
      );
    `);
  }

  createUser(email: string, plan: Plan = "free"): ProxyUser {
    const user: ProxyUser = { id: randomUUID(), email: email.trim().toLowerCase(), plan, createdAt: new Date().toISOString() };
    this.db.prepare("INSERT INTO users (id, email, plan, created_at) VALUES (?, ?, ?, ?)").run(user.id, user.email, user.plan, user.createdAt);
    return user;
  }

  findUser(idOrEmail: string): ProxyUser | null {
    const r = this.db
      .prepare("SELECT id, email, plan, created_at FROM users WHERE id = ? OR email = ?")
      .get(idOrEmail, idOrEmail.trim().toLowerCase()) as { id: string; email: string; plan: Plan; created_at: string } | undefined;
    return r ? { id: r.id, email: r.email, plan: r.plan, createdAt: r.created_at } : null;
  }

  setPlan(userId: string, plan: Plan): void {
    this.db.prepare("UPDATE users SET plan = ? WHERE id = ?").run(plan, userId);
  }

  listUsers(): ProxyUser[] {
    return (this.db.prepare("SELECT id, email, plan, created_at FROM users ORDER BY created_at").all() as {
      id: string; email: string; plan: Plan; created_at: string;
    }[]).map((r) => ({ id: r.id, email: r.email, plan: r.plan, createdAt: r.created_at }));
  }

  /** A new key for the user. The plaintext is returned here and never again. */
  issueKey(userId: string): { key: string; prefix: string } {
    const key = `${KEY_PREFIX}${randomBytes(24).toString("base64url")}`;
    const prefix = key.slice(0, 12);
    this.db
      .prepare("INSERT INTO api_keys (hash, prefix, user_id, created_at) VALUES (?, ?, ?, ?)")
      .run(hashKey(key), prefix, userId, new Date().toISOString());
    return { key, prefix };
  }

  /** The user a live key belongs to, or null (unknown, malformed or revoked). */
  authenticate(key: string | undefined): ProxyUser | null {
    if (!key || !key.startsWith(KEY_PREFIX)) return null;
    const r = this.db
      .prepare(
        `SELECT u.id, u.email, u.plan, u.created_at FROM api_keys k JOIN users u ON u.id = k.user_id
         WHERE k.hash = ? AND k.revoked_at IS NULL`,
      )
      .get(hashKey(key)) as { id: string; email: string; plan: Plan; created_at: string } | undefined;
    return r ? { id: r.id, email: r.email, plan: r.plan, createdAt: r.created_at } : null;
  }

  /** Revoke by the prefix shown at creation. Returns how many keys it revoked. */
  revokeKey(prefix: string): number {
    const res = this.db
      .prepare("UPDATE api_keys SET revoked_at = ? WHERE prefix = ? AND revoked_at IS NULL")
      .run(new Date().toISOString(), prefix);
    return Number(res.changes);
  }

  record(userId: string, route: string, tokens: number, microUsd: number, month = monthOf()): void {
    this.db
      .prepare(
        `INSERT INTO usage (user_id, month, route, requests, tokens, micro_usd) VALUES (?, ?, ?, 1, ?, ?)
         ON CONFLICT (user_id, month, route) DO UPDATE SET
           requests = requests + 1, tokens = tokens + excluded.tokens, micro_usd = micro_usd + excluded.micro_usd`,
      )
      .run(userId, month, route, Math.max(0, Math.round(tokens)), Math.max(0, Math.round(microUsd)));
  }

  monthUsage(userId: string, month = monthOf()): MonthUsage {
    const rows = this.db
      .prepare("SELECT route, requests, tokens, micro_usd FROM usage WHERE user_id = ? AND month = ?")
      .all(userId, month) as { route: string; requests: number; tokens: number; micro_usd: number }[];
    const out: MonthUsage = { month, requests: 0, tokens: 0, microUsd: 0, byRoute: {} };
    for (const r of rows) {
      out.requests += Number(r.requests);
      out.tokens += Number(r.tokens);
      out.microUsd += Number(r.micro_usd);
      out.byRoute[r.route] = { requests: Number(r.requests), tokens: Number(r.tokens), microUsd: Number(r.micro_usd) };
    }
    return out;
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // best-effort
    }
  }
}
