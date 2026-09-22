/**
 * GatewaySettings resolution (Phase 2.5).
 *
 * Two of these tests are regressions for divergences that existed before this
 * module: `topology/store.ts` omitted the CONTEXT_GATEWAY_STATE fallback its six
 * sibling stores had, and `createApp` resolved vectorDir from $HOME, so setting
 * a state dir relocated every store EXCEPT the vectors. Both were silent.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSettings, settingsPath, loadSettingsFile } from "../src/settings.js";
import { defaultTopologyPath } from "../src/topology/store.js";
import { defaultAclPath } from "../src/security/acl.js";

const ENV = [
  "CONTEXT_GATEWAY_STATE",
  "GATEWAY_BACKEND",
  "GATEWAY_INDEX_DIR",
  "GATEWAY_VECTOR_DIR",
  "GATEWAY_VECTOR_BACKEND",
  "GATEWAY_EMBED_ENGINE",
  "GATEWAY_RERANKER",
  "GATEWAY_ALLOWED_HOSTS",
] as const;
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  for (const k of ENV) delete process.env[k];
});
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
});

describe("resolveSettings", () => {
  it("defaults everything under the home state dir", () => {
    const s = resolveSettings();
    expect(s.stateDir).toContain(".context-gateway");
    expect(s.indexDir).toBe(join(s.stateDir, "index-tantivy"));
    expect(s.vectorDir).toBe(join(s.stateDir, "vectors-lance"));
    expect(s.backend).toBe("tantivy");
    expect(s.reranker).toBeNull(); // null = resolve by availability
  });

  it("puts explicit options above the environment", () => {
    process.env.CONTEXT_GATEWAY_STATE = "/env/state";
    expect(resolveSettings({ stateDir: "/opt/state" }).stateDir).toBe("/opt/state");
  });

  it("puts the environment above settings.json", () => {
    // Deliberate: every existing user and all the tests configure via env, so a
    // newly-introduced file must not silently outrank them.
    const dir = mkdtempSync(join(tmpdir(), "acg-settings-"));
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ version: 1, backend: "sqlite" }));
    process.env.GATEWAY_BACKEND = "tantivy";
    expect(resolveSettings({ stateDir: dir }).backend).toBe("tantivy");
  });

  it("reads settings.json when the environment is silent", () => {
    const dir = mkdtempSync(join(tmpdir(), "acg-settings-"));
    writeFileSync(
      join(dir, "settings.json"),
      JSON.stringify({ version: 1, backend: "sqlite", reranker: "voyage", embedEngine: "voyage-code" }),
    );
    const s = resolveSettings({ stateDir: dir });
    expect(s.backend).toBe("sqlite");
    expect(s.reranker).toBe("voyage");
    expect(s.embedEngine).toBe("voyage-code");
    expect(s.indexDir).toBe(join(dir, "index-sqlite")); // backend steers the default index dir
  });

  it("survives a malformed settings.json rather than throwing", () => {
    const dir = mkdtempSync(join(tmpdir(), "acg-settings-"));
    writeFileSync(join(dir, "settings.json"), "{ not json");
    expect(loadSettingsFile(dir)).toEqual({});
    expect(() => resolveSettings({ stateDir: dir })).not.toThrow();
  });

  it("ignores an unknown enum value instead of trusting it", () => {
    process.env.GATEWAY_RERANKER = "nonsense";
    expect(resolveSettings().reranker).toBeNull();
  });

  it("splits allowedHosts and drops blanks", () => {
    process.env.GATEWAY_ALLOWED_HOSTS = "a.local, b.local ,";
    expect(resolveSettings().allowedHosts).toEqual(["a.local", "b.local"]);
  });

  it("never carries GATEWAY_TOKEN", () => {
    // Read per-request in http.ts by design: the menu-bar app cannot supply it
    // and an operator must be able to rotate it without a restart.
    expect(JSON.stringify(resolveSettings())).not.toContain("TOKEN");
    expect(Object.keys(resolveSettings())).not.toContain("token");
  });

  it("places settings.json inside the state dir", () => {
    expect(settingsPath("/x/y")).toBe(join("/x/y", "settings.json"));
  });
});

describe("state dir divergences, now fixed", () => {
  it("topology honours CONTEXT_GATEWAY_STATE like its siblings", () => {
    process.env.CONTEXT_GATEWAY_STATE = "/custom/state";
    // Before: topology ignored the env var and fell back to $HOME while acl,
    // feedback, temporal, subscriptions and remotes all honoured it.
    expect(defaultTopologyPath()).toBe(join("/custom/state", "topology.json"));
    expect(defaultAclPath()).toBe(join("/custom/state", "acl.json"));
  });

  it("vectors live under the state dir, not $HOME", async () => {
    // Before: createApp built vectorDir from $HOME, so a custom state dir moved
    // six stores and silently left the vector store behind.
    const dir = mkdtempSync(join(tmpdir(), "acg-vecdir-"));
    mkdirSync(dir, { recursive: true });
    const { createApp, closeApp } = await import("../src/app.js");
    const app = createApp({ stateDir: dir });
    try {
      expect(app.vectorDir).toBe(join(dir, "vectors-lance"));
      expect(app.settings.stateDir).toBe(dir);
    } finally {
      closeApp(app);
    }
  });
});
