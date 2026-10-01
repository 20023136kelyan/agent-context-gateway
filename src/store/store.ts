/**
 * The local item store: one SQLite file, schema versioned through PRAGMA user_version.
 * Synchronous on purpose: the daemon reads it into memory and answers delivery
 * queries from there, so the store is only on the write path.
 */
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import type { DatabaseSync as DatabaseSyncT } from "node:sqlite";
import { ItemError, normalizeAnchor, validateNewItem, type Anchor, type Evidence, type Item, type ItemStatus, type ItemType, type NewItem } from "./items.js";

// Lazy: node:sqlite prints an experimental warning on import in some Node versions.
const require = createRequire(import.meta.url);
function openDatabase(path: string): DatabaseSyncT {
  const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
  return new DatabaseSync(path);
}

/** Each entry moves the schema up one version. Never edit a released step; add a new one. */
const MIGRATIONS: string[] = [
  `CREATE TABLE items (
     id TEXT PRIMARY KEY,
     repo TEXT NOT NULL,
     type TEXT NOT NULL,
     text TEXT NOT NULL,
     anchor_kind TEXT NOT NULL,
     anchor_path TEXT,
     anchor_symbol TEXT,
     line_start INTEGER,
     line_end INTEGER,
     source_kind TEXT NOT NULL,
     source_author TEXT,
     confidence REAL NOT NULL,
     status TEXT NOT NULL,
     valid_from TEXT NOT NULL,
     valid_until TEXT,
     superseded_by TEXT,
     votes_up INTEGER NOT NULL DEFAULT 0,
     votes_down INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE INDEX items_repo_status ON items (repo, status);
   CREATE INDEX items_repo_path ON items (repo, anchor_path);
   CREATE TABLE evidence (
     item_id TEXT NOT NULL REFERENCES items (id) ON DELETE CASCADE,
     seq INTEGER NOT NULL,
     kind TEXT NOT NULL,
     ref TEXT NOT NULL,
     detail TEXT,
     at TEXT,
     PRIMARY KEY (item_id, seq)
   );`,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

export function defaultStorePath(): string {
  if (process.env.BIFROST_DB) return process.env.BIFROST_DB;
  const dataHome = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  return join(dataHome, "bifrost", "bifrost.db");
}

export interface ItemFilter {
  repo?: string;
  status?: ItemStatus | ItemStatus[];
  type?: ItemType;
}

export interface ItemEdit {
  text?: string;
  type?: ItemType;
  anchor?: Anchor;
  confidence?: number;
  status?: ItemStatus;
}

type Row = Record<string, string | number | null>;

export class ItemStore {
  private db: DatabaseSyncT;

  constructor(
    path: string = defaultStorePath(),
    private now: () => Date = () => new Date(),
  ) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = openDatabase(path);
    this.db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
    this.migrate();
  }

  get schemaVersion(): number {
    return Number((this.db.prepare("PRAGMA user_version").get() as Row).user_version);
  }

  private migrate(): void {
    const current = this.schemaVersion;
    if (current > MIGRATIONS.length) throw new Error(`store schema ${current} is newer than this version of Bifröst (${MIGRATIONS.length})`);
    for (let v = current; v < MIGRATIONS.length; v++) {
      this.transaction(() => {
        this.db.exec(MIGRATIONS[v]);
        this.db.exec(`PRAGMA user_version = ${v + 1}`);
      });
    }
  }

  private depth = 0;

  /** Runs fn atomically. Nested calls become savepoints, so writes compose. */
  private transaction<T>(fn: () => T): T {
    const savepoint = `sp${this.depth}`;
    this.db.exec(this.depth === 0 ? "BEGIN" : `SAVEPOINT ${savepoint}`);
    this.depth++;
    try {
      const out = fn();
      this.depth--;
      this.db.exec(this.depth === 0 ? "COMMIT" : `RELEASE ${savepoint}`);
      return out;
    } catch (err) {
      this.depth--;
      this.db.exec(this.depth === 0 ? "ROLLBACK" : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
      throw err;
    }
  }

  private stamp(): string {
    return this.now().toISOString();
  }

  add(input: NewItem): Item {
    const v = validateNewItem(input);
    const at = this.stamp();
    const id = `itm_${randomBytes(8).toString("hex")}`;
    const a = v.anchor;
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO items (id, repo, type, text, anchor_kind, anchor_path, anchor_symbol, line_start, line_end,
             source_kind, source_author, confidence, status, valid_from, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id, v.repo, v.type, v.text, a.kind,
          a.kind === "project" ? null : a.path,
          a.kind === "symbol" ? a.symbol : null,
          "lines" in a && a.lines ? a.lines[0] : null,
          "lines" in a && a.lines ? a.lines[1] : null,
          v.source.kind, v.source.author ?? null, v.confidence ?? 1, v.status ?? "active", v.validFrom ?? at, at, at,
        );
      for (const e of v.evidence ?? []) this.insertEvidence(id, e);
    });
    return this.require(id);
  }

  private insertEvidence(id: string, e: Evidence): void {
    const next = Number((this.db.prepare("SELECT COALESCE(MAX(seq), -1) + 1 AS n FROM evidence WHERE item_id = ?").get(id) as Row).n);
    this.db.prepare("INSERT INTO evidence (item_id, seq, kind, ref, detail, at) VALUES (?, ?, ?, ?, ?, ?)").run(id, next, e.kind, e.ref, e.detail ?? null, e.at ?? null);
  }

  get(id: string): Item | undefined {
    const row = this.db.prepare("SELECT * FROM items WHERE id = ?").get(id) as Row | undefined;
    return row ? this.toItem(row) : undefined;
  }

  private require(id: string): Item {
    const item = this.get(id);
    if (!item) throw new ItemError(`no item ${id}`);
    return item;
  }

  list(filter: ItemFilter = {}): Item[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (filter.repo) {
      where.push("repo = ?");
      args.push(filter.repo);
    }
    if (filter.status) {
      const s = Array.isArray(filter.status) ? filter.status : [filter.status];
      where.push(`status IN (${s.map(() => "?").join(", ")})`);
      args.push(...s);
    }
    if (filter.type) {
      where.push("type = ?");
      args.push(filter.type);
    }
    const sql = `SELECT * FROM items${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at, rowid`;
    return (this.db.prepare(sql).all(...args) as Row[]).map((r) => this.toItem(r));
  }

  /** Active items of a repository that are valid at `at` (now by default): what delivery may show. */
  activeAt(repo: string, at: Date = this.now()): Item[] {
    const t = at.toISOString();
    return (this.db
      .prepare("SELECT * FROM items WHERE repo = ? AND status = 'active' AND valid_from <= ? AND (valid_until IS NULL OR valid_until > ?) ORDER BY created_at, rowid")
      .all(repo, t, t) as Row[]).map((r) => this.toItem(r));
  }

  edit(id: string, patch: ItemEdit): Item {
    const item = this.require(id);
    const next = validateNewItem({
      repo: item.repo,
      type: patch.type ?? item.type,
      text: patch.text ?? item.text,
      anchor: patch.anchor ?? item.anchor,
      source: item.source,
      confidence: patch.confidence ?? item.confidence,
    });
    const a = normalizeAnchor(next.anchor);
    this.db
      .prepare(
        `UPDATE items SET type = ?, text = ?, anchor_kind = ?, anchor_path = ?, anchor_symbol = ?, line_start = ?, line_end = ?,
           confidence = ?, status = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        next.type, next.text, a.kind,
        a.kind === "project" ? null : a.path,
        a.kind === "symbol" ? a.symbol : null,
        "lines" in a && a.lines ? a.lines[0] : null,
        "lines" in a && a.lines ? a.lines[1] : null,
        next.confidence ?? item.confidence, patch.status ?? item.status, this.stamp(), id,
      );
    return this.require(id);
  }

  /** Ends an item's validity now. It stays in the store as history. */
  retire(id: string, reason?: string): Item {
    const at = this.stamp();
    this.transaction(() => {
      this.require(id);
      this.db.prepare("UPDATE items SET status = 'retired', valid_until = COALESCE(valid_until, ?), updated_at = ? WHERE id = ?").run(at, at, id);
      if (reason) this.insertEvidence(id, { kind: "note", ref: "retired", detail: reason, at });
    });
    return this.require(id);
  }

  /** Replaces an item with a new one: the old item ends now and points at its successor. */
  supersede(id: string, replacement: NewItem): { old: Item; replacement: Item } {
    const old = this.require(id);
    if (replacement.repo !== old.repo) throw new ItemError("a replacement must belong to the same repository");
    let next!: Item;
    this.transaction(() => {
      next = this.add(replacement);
      const at = this.stamp();
      this.db.prepare("UPDATE items SET status = 'retired', valid_until = ?, superseded_by = ?, updated_at = ? WHERE id = ?").run(at, next.id, at, id);
    });
    return { old: this.require(id), replacement: next };
  }

  vote(id: string, direction: "up" | "down"): Item {
    this.require(id);
    const col = direction === "up" ? "votes_up" : "votes_down";
    this.db.prepare(`UPDATE items SET ${col} = ${col} + 1, updated_at = ? WHERE id = ?`).run(this.stamp(), id);
    return this.require(id);
  }

  addEvidence(id: string, evidence: Evidence): Item {
    this.require(id);
    this.insertEvidence(id, evidence);
    return this.require(id);
  }

  close(): void {
    this.db.close();
  }

  private toItem(r: Row): Item {
    const kind = String(r.anchor_kind);
    const lines = r.line_start != null && r.line_end != null ? ([Number(r.line_start), Number(r.line_end)] as [number, number]) : undefined;
    const anchor: Anchor =
      kind === "project"
        ? { kind: "project" }
        : kind === "folder"
          ? { kind: "folder", path: String(r.anchor_path) }
          : kind === "symbol"
            ? { kind: "symbol", path: String(r.anchor_path), symbol: String(r.anchor_symbol), ...(lines ? { lines } : {}) }
            : { kind: "file", path: String(r.anchor_path), ...(lines ? { lines } : {}) };
    const evidence = (this.db.prepare("SELECT kind, ref, detail, at FROM evidence WHERE item_id = ? ORDER BY seq").all(String(r.id)) as Row[]).map(
      (e) => ({ kind: e.kind, ref: e.ref, ...(e.detail != null ? { detail: e.detail } : {}), ...(e.at != null ? { at: e.at } : {}) }) as Evidence,
    );
    return {
      id: String(r.id),
      repo: String(r.repo),
      type: r.type as ItemType,
      text: String(r.text),
      anchor,
      evidence,
      source: { kind: r.source_kind as Item["source"]["kind"], ...(r.source_author != null ? { author: String(r.source_author) } : {}) },
      confidence: Number(r.confidence),
      status: r.status as ItemStatus,
      validFrom: String(r.valid_from),
      ...(r.valid_until != null ? { validUntil: String(r.valid_until) } : {}),
      ...(r.superseded_by != null ? { supersededBy: String(r.superseded_by) } : {}),
      votes: { up: Number(r.votes_up), down: Number(r.votes_down) },
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    };
  }
}
