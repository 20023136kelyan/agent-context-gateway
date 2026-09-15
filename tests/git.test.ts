/**
 * Unit & Integration tests for Git Hooks & Commit Event Auto-Indexing (spec §28 & §32).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { installGitHooks, handleGitCommitEvent } from "../src/git/hooks.js";
import { createApp, closeApp, type GatewayApp } from "../src/app.js";
import { searchOnce } from "../src/commands.js";

describe("Git Hooks Installation", () => {
  let gitRepoDir: string;

  beforeAll(async () => {
    gitRepoDir = await mkdtemp(join(tmpdir(), "acg-git-test-"));
    execFileSync("git", ["init", "-q", gitRepoDir]);
  });

  it("installs executable post-commit and post-merge hooks", () => {
    const res = installGitHooks(gitRepoDir);
    expect(res.installed.length).toBe(2);

    const postCommitPath = join(gitRepoDir, ".git", "hooks", "post-commit");
    const postMergePath = join(gitRepoDir, ".git", "hooks", "post-merge");

    expect(existsSync(postCommitPath)).toBe(true);
    expect(existsSync(postMergePath)).toBe(true);

    const stat = statSync(postCommitPath);
    // Executable bit set (0o755)
    expect(stat.mode & 0o111).toBeGreaterThan(0);
  });

  it("throws clear error when not a git repo", () => {
    expect(() => installGitHooks(join(tmpdir(), "not-a-git-repo-random-xyz"))).toThrow(
      "not_a_git_repo",
    );
  });
});

describe("Git Commit Event Indexing & Search", () => {
  let app: GatewayApp;
  let repoDir: string;
  let realSha: string;

  beforeAll(async () => {
    repoDir = await mkdtemp(join(tmpdir(), "acg-git-repo-"));
    execFileSync("git", ["init", "-q", repoDir]);
    execFileSync("git", ["-C", repoDir, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", repoDir, "config", "user.name", "Test User"]);
    await writeFile(join(repoDir, "useLiveSession.ts"), "export const liveSession = true;");
    execFileSync("git", ["-C", repoDir, "add", "."]);
    execFileSync("git", ["-C", repoDir, "commit", "-qm", "feat(collab): complete phase 8 coordinated production deployment"]);
    realSha = execFileSync("git", ["-C", repoDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

    const root = await mkdtemp(join(tmpdir(), "acg-git-idx-"));
    app = createApp({
      indexDir: join(root, "index"),
      claudeDir: join(root, "empty-c"),
      codexDir: join(root, "empty-x"),
      gitRepos: [repoDir],
      backend: "tantivy",
      cursorDb: join(root, "no.vscdb"),
    });

    // Simulate incoming git commit event
    await handleGitCommitEvent(app, {
      repo: repoDir,
      sha: realSha,
      branch: "main",
      message: "feat(collab): complete phase 8 coordinated production deployment",
      files: ["useLiveSession.ts"],
      timestamp: "2026-09-15T12:00:00Z",
    });
  });

  afterAll(() => closeApp(app));

  it("indexes commit turn and makes it retrievable by commit SHA and commit message", async () => {
    const res = await searchOnce(app, "phase 8 coordinated production deployment");
    expect(res.results.length).toBeGreaterThanOrEqual(1);

    const top = res.results[0];
    expect(top.provenance.harness).toBe("git");
    expect(top.provenance.turnId).toContain(realSha.slice(0, 8));
    expect(top.artifacts).toContain(`commit:${realSha.slice(0, 8)}`);
    expect(top.artifacts).toContain("useLiveSession.ts");
  });
});
