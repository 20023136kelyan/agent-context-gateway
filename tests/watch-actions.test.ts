/**
 * serve --watch refreshes the action index like every other sync path. It
 * did not: actions (and so outcome records) went stale while watching.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp, closeApp } from "../src/app.js";
import { watchSources } from "../src/watch.js";

const T = (m: number) => `2026-09-20T10:${String(m).padStart(2, "0")}:00Z`;

describe("watch mode refreshes the action index", () => {
  it("a session written while watching shows up in find_actions", async () => {
    const root = mkdtempSync(join(tmpdir(), "acg-watch-actions-"));
    const dir = join(root, "claude", "-Users-bob-app");
    mkdirSync(dir, { recursive: true });
    const dead = (n: string) => {
      const d = join(root, n);
      mkdirSync(d, { recursive: true });
      return d;
    };
    const app = createApp({
      stateDir: join(root, "state"), claudeDir: join(root, "claude"), codexDir: dead("codex"), indexDir: join(root, "index"), backend: "sqlite",
      cursorDb: dead("cursor"), zepDir: dead("zep"), opencodeDb: dead("opencode"), trajectoryDir: dead("traj"), gitRepos: [],
    });
    const synced = new Promise<void>((resolve) => {
      const ws = watchSources(app, { dirs: [join(root, "claude")], debounceMs: 50, onSync: () => { ws.forEach((w) => w.close()); resolve(); } });
    });
    writeFileSync(
      join(dir, "s2.jsonl"),
      [
        JSON.stringify({ type: "user", uuid: "u1", sessionId: "s2", cwd: "/Users/bob/app", timestamp: T(0), message: { role: "user", content: "run the migration" } }),
        JSON.stringify({ type: "assistant", uuid: "a1", sessionId: "s2", cwd: "/Users/bob/app", timestamp: T(1), message: { role: "assistant", content: [{ type: "tool_use", id: "b1", name: "Bash", input: { command: "npm run db:migrate" } }] } }),
      ].join("\n"),
    );
    await synced;
    // Read the store directly: findActions syncs first, which would hide a
    // watcher that never recorded anything.
    expect(app.actions.find({ command: "db:migrate" }).map((a) => a.sessionId)).toEqual(["s2"]);
    closeApp(app);
    rmSync(root, { recursive: true, force: true });
  });
});
