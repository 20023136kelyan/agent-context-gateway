/**
 * Setup primitives: detection, .env management, Claude hook installer.
 * Pure filesystem logic against injectable paths — no app instances, so
 * every branch is unit-testable without an index.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { detectHistories, keyStatus, appendEnvKeys, installClaudeHook, HOOK_MARKER } from "../src/setup.js";

describe("setup", () => {
  it("detects histories under a fake HOME", () => {
    const root = mkdtempSync(join(tmpdir(), "acg-setup-"));
    const found = detectHistories({ ...process.env, HOME: root });
    expect(found.map((f) => [f.kind, f.present])).toEqual([
      ["claude-code", false],
      ["codex", false],
    ]);
  });

  it("reports key presence without values", () => {
    const s = keyStatus({ ...process.env, VOYAGE_API_KEY: "secret", TYPESAFE_API_KEY: undefined, JEV_API_KEY: undefined });
    expect(s).toEqual({ VOYAGE_API_KEY: true, TYPESAFE_API_KEY: false });
    expect(JSON.stringify(s)).not.toContain("secret");
  });

  it("appends missing keys without touching existing ones", () => {
    const root = mkdtempSync(join(tmpdir(), "acg-setup-"));
    const p = join(root, ".env");
    writeFileSync(p, "# comment\nVOYAGE_API_KEY=old\n");
    const added = appendEnvKeys(p, { VOYAGE_API_KEY: "new", TYPESAFE_API_KEY: "t" });
    expect(added).toEqual(["TYPESAFE_API_KEY"]);
    const body = readFileSync(p, "utf8");
    expect(body).toContain("VOYAGE_API_KEY=old");
    expect(body).not.toContain("VOYAGE_API_KEY=new");
    expect(appendEnvKeys(p, { TYPESAFE_API_KEY: "t2" })).toEqual([]);
  });

  it("installs the Claude hook idempotently with backup", () => {
    const root = mkdtempSync(join(tmpdir(), "acg-setup-"));
    const p = join(root, "settings.json");
    writeFileSync(p, JSON.stringify({ hooks: { SessionEnd: [] }, other: 1 }));
    const first = installClaudeHook(p, "/x/cli.ts");
    expect(first.installed).toBe(true);
    expect(first.backupPath).toContain("pre-gateway-");
    const second = installClaudeHook(p, "/x/cli.ts");
    expect(second.installed).toBe(false);
    const body = JSON.parse(readFileSync(p, "utf8"));
    expect(body.other).toBe(1);
    expect(JSON.stringify(body).includes(HOOK_MARKER)).toBe(true);
  });

  it("creates settings from scratch when missing", () => {
    const root = mkdtempSync(join(tmpdir(), "acg-setup-"));
    const p = join(root, "sub", "settings.json");
    const r = installClaudeHook(p, "/x/cli.ts");
    expect(r.installed).toBe(true);
    expect(r.backupPath).toBeNull();
  });
});
