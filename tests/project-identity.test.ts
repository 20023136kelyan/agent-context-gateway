/**
 * Cross-harness project identity (src/core/project.ts). Claude Code names a
 * project by its directory slug, Codex by the cwd basename; the same repo can
 * be "Cozea 2.0" on one machine and "cozea-2.0" on another.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { projectKey, inProject, sessionProjectKeys } from "../src/core/project.js";
import { callerProject } from "../src/adapters/repo.js";
import { resolveProject } from "../src/commands.js";
import type { GatewayApp } from "../src/app.js";

const claude = { projectId: "-Users-alice-dev-Cozea-2-0", workspace: "/Users/alice/dev/Cozea 2.0", repo: null };
const codex = { projectId: "cozea-2.0", workspace: "/home/bob/work/cozea-2.0", repo: "/home/bob/work/cozea-2.0" };
const other = { projectId: "flipman-web", workspace: "/Users/alice/dev/flipman-web", repo: null };

describe("project identity", () => {
  it("normalises spelling: case and punctuation do not make a new project", () => {
    expect(projectKey("Cozea 2.0")).toBe("cozea20");
    expect(projectKey("cozea-2.0")).toBe(projectKey("COZEA_2_0"));
  });

  it("matches one repo across harnesses and machines by name", () => {
    expect(inProject(claude, "cozea-2.0")).toBe(true);
    expect(inProject(codex, "Cozea 2.0")).toBe(true);
    expect(inProject(other, "cozea-2.0")).toBe(false);
  });

  it("still honours an exact projectId, so existing filters keep working", () => {
    expect(inProject(claude, "-Users-alice-dev-Cozea-2-0")).toBe(true);
  });

  it("does not match on an empty or punctuation-only name", () => {
    expect(inProject(other, "")).toBe(false);
    expect(inProject(other, "--")).toBe(false);
  });

  it("collects keys from the repo root, the workspace and the projectId", () => {
    expect(sessionProjectKeys(codex)).toEqual(new Set(["cozea20"]));
    expect(sessionProjectKeys(claude)).toEqual(new Set(["cozea20", "usersalicedevcozea20"]));
  });
});

describe("callerProject: the project an agent is calling from", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "acg-caller-")));
  const home = join(root, "home", "alice");
  const repo = join(home, "dev", "Cozea 2.0");
  mkdirSync(join(repo, "apps", "web"), { recursive: true });
  execFileSync("git", ["init", "-q", repo]);
  const plain = join(home, "notes");
  mkdirSync(plain, { recursive: true });

  it("names the git repo, even from a subdirectory", () => {
    expect(callerProject(join(repo, "apps", "web"), home)).toBe("Cozea 2.0");
  });

  it("names a plain directory outside any repo", () => {
    expect(callerProject(plain, home)).toBe("notes");
  });

  it("names nothing at home, above home, or at the filesystem root", () => {
    expect(callerProject(home, home)).toBeNull();
    expect(callerProject(join(root, "home"), home)).toBeNull();
    expect(callerProject("/", home)).toBeNull();
  });
});

describe("resolveProject: which project a search runs in", () => {
  const app = { search: { hasProject: async (p: string) => p === "app" } } as unknown as GatewayApp;

  it("defaults to the caller's project when it has history", async () => {
    expect(await resolveProject(app, { defaultProject: "app" })).toEqual({ project: "app", source: "caller" });
  });

  it("falls back to every project when the caller's has no history yet", async () => {
    expect(await resolveProject(app, { defaultProject: "brand-new" })).toEqual({ project: null, source: "all" });
  });

  it("lets an explicit project win, and '*' mean every project", async () => {
    expect(await resolveProject(app, { project: "other", defaultProject: "app" })).toEqual({ project: "other", source: "explicit" });
    expect(await resolveProject(app, { project: "*", defaultProject: "app" })).toEqual({ project: null, source: "all" });
  });

  it("never defaults topology scopes, whose linked sessions may span projects", async () => {
    for (const scope of ["parent", "children", "siblings", "auto"]) {
      expect(await resolveProject(app, { scope, defaultProject: "app" })).toEqual({ project: null, source: "all" });
    }
  });
});
