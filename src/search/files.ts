/**
 * Prompt -> files -> sessions: rank earlier sessions by the files they edited.
 *
 * A later prompt often names what an earlier session touched ("the Stripe
 * webhook", "fix HowItWorks hydration") in words the conversation itself
 * never used. The action index already knows every file each session edited,
 * so this ranks sessions by how well the prompt's words match those paths,
 * model-free: paths and prompt split into identifier words (camelCase,
 * snake_case, kebab-case, path segments), each word weighted by how few
 * sessions in scope edited a path containing it (idf). Issue-localisation
 * work (SweRank, SHERLOC) gets most of its file accuracy from exactly this
 * kind of lexical path signal before any model runs.
 */
import type { EditedFile } from "../actions/store.js";

/** Path words that say nothing about what a session did. */
const GENERIC = new Set([
  "src", "lib", "app", "apps", "index", "main", "test", "tests", "spec", "specs", "util", "utils", "dist", "build",
  "packages", "package", "components", "component", "pages", "public", "assets", "scripts", "docs", "readme",
  "json", "yaml", "yml", "toml", "lock", "md", "mdx", "txt", "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "rs",
  "go", "java", "kt", "swift", "css", "scss", "html", "sh", "sql", "env", "config", "users", "home", "tmp",
]);

/** Identifier words of a path or a prompt, lowercased and lightly stemmed. */
export function identifierWords(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/[^A-Za-z0-9]+/)) {
    // camelCase / PascalCase / acronyms: "HowItWorks" -> how it works, "parseURLPath" -> parse url path
    for (const part of raw.split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/)) {
      const w = stem(part.toLowerCase());
      if (w.length > 2 && !GENERIC.has(w) && !/^\d+$/.test(w)) out.push(w);
    }
  }
  return out;
}

function stem(w: string): string {
  if (w.length > 5 && w.endsWith("ies")) return `${w.slice(0, -3)}y`;
  if (w.length > 4 && w.endsWith("es") && /(ch|sh|x|ss)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

export interface FileMatch {
  harness: string;
  sessionId: string;
  /** The turn that last edited the best-matching file. */
  turnId: string;
  score: number;
  /** The files that matched, best first. */
  files: string[];
}

/**
 * Sessions ranked by how well the query's words match the files they edited.
 * A session scores the idf of each distinct query word found in its paths;
 * words in more than half the sessions in scope count for nothing. Sessions
 * whose best word is that common, or that match nothing, are left out.
 */
export function rankSessionsByFiles(query: string, edits: EditedFile[], limit = 10): FileMatch[] {
  const q = new Set(identifierWords(query));
  if (q.size === 0 || edits.length === 0) return [];
  const bySession = new Map<string, EditedFile[]>();
  for (const e of edits) {
    const k = `${e.harness}\u0000${e.sessionId}`;
    bySession.set(k, [...(bySession.get(k) ?? []), e]);
  }
  const n = bySession.size;
  const words = new Map<string, Set<string>>(); // session -> its path words
  const df = new Map<string, number>();
  for (const [k, files] of bySession) {
    const ws = new Set(files.flatMap((f) => identifierWords(f.rel)));
    words.set(k, ws);
    for (const w of ws) if (q.has(w)) df.set(w, (df.get(w) ?? 0) + 1);
  }
  const idf = (w: string) => {
    const d = df.get(w) ?? 0;
    return d === 0 || d > n / 2 ? 0 : Math.log(n / d);
  };
  const out: FileMatch[] = [];
  for (const [k, files] of bySession) {
    const ws = words.get(k)!;
    let score = 0;
    for (const w of q) if (ws.has(w)) score += idf(w);
    // One session in scope: nothing to tell apart, any match is signal.
    if (score <= 0 && !(n === 1 && [...q].some((w) => ws.has(w)))) continue;
    const scored = files
      .map((f) => {
        const fw = new Set(identifierWords(f.rel));
        let s = 0;
        for (const w of q) if (fw.has(w)) s += idf(w) || 0.01;
        return { f, s };
      })
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s || b.f.ts.localeCompare(a.f.ts));
    const best = scored[0]!.f;
    out.push({ harness: best.harness, sessionId: best.sessionId, turnId: best.turnId, score, files: scored.slice(0, 5).map((x) => x.f.rel) });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}
