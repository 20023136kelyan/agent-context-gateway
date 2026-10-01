/**
 * Runs experiment tasks through the product itself instead of the kit: notes are
 * imported into a real store, a real daemon serves them, and OpenCode loads the
 * built plugin and the fixed explanation, exactly as `bifrost install opencode` sets
 * them up. Checks that M1 reproduces the experiment's explained-push results.
 *
 * Known issue, not fixed: the daemon runs in this process and spawnSync blocks it
 * while the agent runs, so no notes are delivered. Superseded by the Rust base's
 * evals/run.mjs in the bifrost repository, which has no daemon.
 *
 *   npm run build
 *   tsx experiments/upper-bound/harness/product-replay.ts --task invoice-csv-taste \
 *     --notes hand-dir --reps 3 --model opencode/muse-spark-1.3-contributor-free --variant low
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { grade, loadTask, prepareWorkspace } from "./run.js";
import { ItemStore } from "../../../src/store/store.js";
import { readKitNotes } from "../../../src/store/import.js";
import { startDaemon } from "../../../src/daemon/server.js";
import { SESSION_EXPLANATION } from "../../../src/delivery/format.js";

const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};

async function main() {
  const task = loadTask(arg("task", "invoice-csv-taste")!);
  const notes = arg("notes", "hand")!;
  const reps = Number(arg("reps", "3"));
  const model = arg("model", "opencode/muse-spark-1.3-contributor-free")!;
  const variant = arg("variant");
  const plugin = pathToFileURL(resolve("dist/clients/opencode-plugin.js")).href;

  const data = mkdtempSync(join(tmpdir(), "bifrost-replay-"));
  const env = { ...process.env, BIFROST_DB: join(data, "bifrost.db"), BIFROST_DAEMON_FILE: join(data, "daemon.json"), BIFROST_PORT: "0" };
  Object.assign(process.env, env);
  const store = new ItemStore(env.BIFROST_DB);
  const daemon = await startDaemon({ store, port: 0, infoPath: env.BIFROST_DAEMON_FILE });
  const explanation = join(data, "session.md");
  writeFileSync(explanation, `${SESSION_EXPLANATION}\n`);

  const results: { rep: number; pass: boolean; trapHit: boolean; shown: string[]; seconds: number }[] = [];
  for (let rep = 1; rep <= reps; rep++) {
    const ws = prepareWorkspace(task);
    for (const item of readKitNotes(join("experiments/upper-bound/tasks", task.id, "notes", `${notes}.json`), ws)) store.add(item);
    const config = { $schema: "https://opencode.ai/config.json", share: "disabled", autoupdate: false, plugin: [plugin], instructions: [explanation], permission: { edit: "allow", bash: "allow", webfetch: "allow", external_directory: "deny" } };
    const args = ["run", "--format", "json", "--dir", ws, "--model", model, ...(variant ? ["--variant", variant] : []), task.prompt];
    const t0 = Date.now();
    // Async on purpose: the daemon runs in this process and must keep answering while the agent works.
    const run = await new Promise<{ stdout: string }>((done) => {
      const child = spawn("opencode", args, { cwd: ws, env: { ...env, OPENCODE_CONFIG_CONTENT: JSON.stringify(config), OPENCODE_DISABLE_CLAUDE_CODE: "1", OPENCODE_DISABLE_AUTOUPDATE: "1" } });
      let stdout = "";
      child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
      const timer = setTimeout(() => child.kill("SIGTERM"), 20 * 60_000);
      child.on("close", () => {
        clearTimeout(timer);
        done({ stdout });
      });
    });
    const seconds = Math.round((Date.now() - t0) / 1000);
    const g = grade(task, ws) as { pass?: boolean; trapHit?: boolean; details?: unknown } | null;
    const all = store.deliveries({ limit: 1000 }).filter((d) => d.at >= new Date(t0).toISOString());
    const shown = [...new Set(all.filter((d) => d.repo === ws).flatMap((d) => d.shown))];
    const repos = [...new Set(all.map((d) => d.repo))];
    if (repos.some((r) => r !== ws)) console.log(`  deliveries logged under other repositories: ${repos.join(", ")}`);
    console.log(`  ${all.length} delivery decisions this run`);
    const blocked = /"type":"error"/.test(run.stdout) && !/"type":"tool_use"/.test(run.stdout);
    results.push({ rep, pass: !!g?.pass, trapHit: !!g?.trapHit, shown, seconds });
    console.log(`${task.id} rep ${rep}: ${blocked ? "INVALID (model error)" : g?.pass ? "PASS" : g?.trapHit ? "TRAP" : "FAIL"} ${seconds}s, ${shown.length} items shown${g?.pass ? "" : ` ${JSON.stringify(g?.details ?? {}).slice(0, 200)}`}`);
    rmSync(ws, { recursive: true, force: true });
  }
  await daemon.close();
  store.close();
  rmSync(data, { recursive: true, force: true });
  console.log(`${results.filter((r) => r.pass).length}/${results.length} passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
