/** Persistent sync cursors (file mtime/size) + last sync timestamps. */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface CursorEntry {
  mtimeMs: number;
  size: number;
}

export class CursorStore {
  private path: string;
  private data: Record<string, CursorEntry>;

  constructor(private dir: string) {
    mkdirSync(dir, { recursive: true });
    this.path = join(dir, "cursors.json");
    this.data = {};
    if (existsSync(this.path)) {
      try {
        this.data = JSON.parse(readFileSync(this.path, "utf8"));
      } catch {
        this.data = {};
      }
    }
  }

  get(path: string): CursorEntry | undefined {
    return this.data[path];
  }

  set(path: string, entry: CursorEntry): void {
    this.data[path] = entry;
  }

  /** Parser version that built this index (adapters/types.ts), null if never recorded. */
  parseVersion(): number | null {
    try {
      const v = Number(readFileSync(join(this.dir, "parse-version"), "utf8").trim());
      return Number.isFinite(v) ? v : null;
    } catch {
      return null;
    }
  }

  setParseVersion(v: number): void {
    writeFileSync(join(this.dir, "parse-version"), String(v));
  }

  save(): void {
    writeFileSync(this.path, JSON.stringify(this.data, null, 2));
  }

  clear(): void {
    this.data = {};
    this.save();
  }
}
