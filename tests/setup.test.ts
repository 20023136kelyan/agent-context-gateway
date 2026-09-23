/**
 * Setup primitives: detection, .env management, Claude hook installer.
 * Pure filesystem logic against injectable paths — no app instances, so
 * every branch is unit-testable without an index.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { detectHistories, keyStatus, appendEnvKeys, installClaudeHook, HOOK_MARKER, PROACTIVE_MARKER } from "../src/setup.js";

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
    const first = installClaudeHook(p, "/x/gw");
    expect(first.installed).toBe(true);
    expect(first.backupPath).toContain("pre-gateway-");
    const second = installClaudeHook(p, "/x/gw");
    expect(second.installed).toBe(false);
    const body = JSON.parse(readFileSync(p, "utf8"));
    expect(body.other).toBe(1);
    expect(JSON.stringify(body).includes(HOOK_MARKER)).toBe(true);
  });

  it("runs hooks through gateway.sh, which loads .env and resolves tsx from the gateway", () => {
    const p = join(mkdtempSync(join(tmpdir(), "acg-setup-")), "settings.json");
    installClaudeHook(p, "/x/gw");
    const cmd = JSON.parse(readFileSync(p, "utf8")).hooks.SessionEnd[0].hooks[0].command as string;
    expect(cmd).toContain('"/x/gw/gateway.sh" sync-session claude-code');
    expect(cmd).not.toContain("--import tsx");
  });

  it("repairs an entry from the old command form in place, without duplicating it", () => {
    const p = join(mkdtempSync(join(tmpdir(), "acg-setup-")), "settings.json");
    const old = { hooks: [{ type: "command", command: `SID=$(jq -r .session_id); node --import tsx "/x/gw/src/cli.ts" sync-session claude-code "$SID" # ${HOOK_MARKER}` }] };
    const mine = { hooks: [{ type: "command", command: "echo my own hook" }] };
    writeFileSync(p, JSON.stringify({ hooks: { SessionEnd: [mine, old] } }));
    expect(installClaudeHook(p, "/x/gw").installed).toBe(true);
    const list = JSON.parse(readFileSync(p, "utf8")).hooks.SessionEnd as { hooks: { command: string }[] }[];
    expect(list).toHaveLength(2);
    expect(list[0]).toEqual(mine);
    expect(list[1].hooks[0].command).toContain("gateway.sh");
  });

  it("adds the proactive prompt hook only when asked, with its own timeout", () => {
    const p = join(mkdtempSync(join(tmpdir(), "acg-setup-")), "settings.json");
    installClaudeHook(p, "/x/gw");
    expect(JSON.parse(readFileSync(p, "utf8")).hooks.UserPromptSubmit).toBeUndefined();
    installClaudeHook(p, "/x/gw", { proactive: true });
    const entry = JSON.parse(readFileSync(p, "utf8")).hooks.UserPromptSubmit[0].hooks[0];
    expect(entry.command).toContain("hook-prompt");
    expect(entry.command).toContain(PROACTIVE_MARKER);
    expect(entry.timeout).toBe(15);
    expect(installClaudeHook(p, "/x/gw", { proactive: true }).installed).toBe(false);
  });

  it("creates settings from scratch when missing", () => {
    const root = mkdtempSync(join(tmpdir(), "acg-setup-"));
    const p = join(root, "sub", "settings.json");
    const r = installClaudeHook(p, "/x/gw");
    expect(r.installed).toBe(true);
    expect(r.backupPath).toBeNull();
  });
});
