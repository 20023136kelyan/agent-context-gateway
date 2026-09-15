/** P2d project-awareness — repo root resolution, facet filter, boost. */
import { describe, it, expect, beforeAll } from "vitest";
import { mkdtemp, mkdir, writeFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { repoRoot } from "../src/adapters/repo.js";
import { ClaudeAdapter } from "../src/adapters/claude.js";
import { TantivyIndex } from "../src/indexing/tantivy-index.js";
import { CursorStore } from "../src/indexing/store.js";
import { syncAll } from "../src/indexing/sync.js";
import { SearchService } from "../src/search/search.js";

let repoA: string;
let repoB: string;
let plain: string;
let claudeDir: string;
let indexDir: string;

const SID_A = "11111111-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const SID_B = "22222222-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

function sess(id: string, cwd: string, text: string): string {
  return [
    JSON.stringify({ type: "user", uuid: "u1", timestamp: "2026-09-10T10:00:00Z", sessionId: id, cwd, message: { role: "user", content: text } }),
    JSON.stringify({ type: "assistant", uuid: "a1", timestamp: "2026-09-10T10:01:00Z", sessionId: id, cwd, message: { role: "assistant", content: [{ type: "text", text: `Noted: ${text}` }] } }),
  ].join("\n");
}

beforeAll(async () => {
  const root = await mkdtemp(join(tmpdir(), "acg-proj-"));
  repoA = join(root, "repoA");
  repoB = join(root, "repoB");
  plain = join(root, "plain");
  for (const d of [repoA, repoB, plain]) await mkdir(d, { recursive: true });
  for (const d of [repoA, repoB]) {
    execFileSync("git", ["init", "-q", d]);
    execFileSync("git", ["-C", d, "config", "user.email", "t@t"]);
    execFileSync("git", ["-C", d, "config", "user.name", "t"]);
    await writeFile(join(d, "f.txt"), "x");
    execFileSync("git", ["-C", d, "add", "."]);
    execFileSync("git", ["-C", d, "commit", "-qm", "init"]);
  }
  claudeDir = join(root, "claude");
  await mkdir(join(claudeDir, "s"), { recursive: true });
  await writeFile(join(claudeDir, "s", `${SID_A}.jsonl`), sess(SID_A, repoA, "Hexagonal architecture stargazer review"));
  await writeFile(join(claudeDir, "s", `${SID_B}.jsonl`), sess(SID_B, repoB, "Hexagonal architecture stargazer review"));
  indexDir = join(root, "index");
  const adapters = [new ClaudeAdapter(claudeDir)];
  const index = new TantivyIndex(indexDir);
  try {
    await syncAll(adapters, index, new CursorStore(indexDir));
  } finally {
    index.close();
  }
});

describe("repoRoot", () => {
  it("resolves inside repos, null outside", async () => {
    const realA = await realpath(repoA);
    expect(repoRoot(repoA)).toBe(realA);
    expect(repoRoot(join(repoA, "sub", "dir"))).toBe(realA);
    expect(repoRoot(plain)).toBe(null);
    expect(repoRoot("unknown")).toBe(null);
  });
});

describe("repo facet", () => {
  function openService() {
    const adapters = [new ClaudeAdapter(claudeDir)];
    const index = new TantivyIndex(indexDir);
    return { svc: new SearchService(adapters, index), index };
  }

  it("sessions carry repo roots", async () => {
    const a = new ClaudeAdapter(claudeDir);
    const sessions = await a.listSessions();
    const byId = new Map(sessions.map((s) => [s.id, s]));
    const realA = await realpath(repoA);
    const realB = await realpath(repoB);
    expect(byId.get(SID_A)?.repo).toBe(realA);
    expect(byId.get(SID_B)?.repo).toBe(realB);
  });

  it("repo filter isolates sessions", async () => {
    const { svc, index } = openService();
    try {
      const realA = await realpath(repoA);
      const res = await svc.search("hexagonal stargazer", { repo: realA });
      expect(res.results.length).toBeGreaterThanOrEqual(1);
      for (const r of res.results) expect(r.provenance.sessionId).toBe(SID_A);
    } finally {
      index.close();
    }
  });
});
