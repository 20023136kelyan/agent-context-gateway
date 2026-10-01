#!/usr/bin/env node
/**
 * bifrost: notes, the daemon, client hooks and installation.
 *
 *   bifrost note add "<text>" --at src/exports/ --type preference
 *   bifrost note list | edit <id> | retire <id> | import <file>
 *   bifrost daemon run | start | stop | status
 *   bifrost hook <client> <event>        (called by agent clients; reads JSON on stdin)
 *   bifrost install <client>             (opencode, claude-code, codex, cursor)
 *   bifrost log                          (what agents were shown)
 */
import { Command, Option } from "commander";
import { fileURLToPath } from "node:url";
import { formatAnchor, ITEM_TYPES, parseAnchor, type Item, type ItemType } from "./store/items.js";
import { gitRoot } from "./delivery/engine.js";
import { readDaemonInfo } from "./paths.js";

const CLI_PATH = fileURLToPath(import.meta.url);

async function openStore() {
  const { ItemStore } = await import("./store/store.js");
  return new ItemStore();
}

function repoOf(opt: string | undefined): string {
  return gitRoot(opt ?? process.cwd());
}

function printItem(i: Item): void {
  const flags = [i.status !== "active" ? i.status : "", i.source.kind !== "hand" ? i.source.kind : ""].filter(Boolean).join(", ");
  console.log(`${i.id}  ${i.type.padEnd(11)} ${formatAnchor(i.anchor)}${flags ? `  [${flags}]` : ""}\n    ${i.text}`);
}

const program = new Command().name("bifrost").description("Notes for coding agents, delivered where they work.");

const note = program.command("note").description("Write and manage notes");
const typeOption = () => new Option("-t, --type <type>", "note type").choices(ITEM_TYPES as unknown as string[]);

note
  .command("add <text>")
  .description("Add a note. --at takes a file, a folder ending in /, file#symbol, or . for the whole project")
  .requiredOption("-a, --at <anchor>", "where it applies")
  .addOption(typeOption().default("preference"))
  .option("--author <name>", "who it comes from", process.env.USER)
  .option("-r, --repo <path>", "repository (default: the current one)")
  .action(async (text: string, o: { at: string; type: ItemType; author?: string; repo?: string }) => {
    const store = await openStore();
    printItem(store.add({ repo: repoOf(o.repo), type: o.type, text, anchor: parseAnchor(o.at), source: { kind: "hand", ...(o.author ? { author: o.author } : {}) } }));
    store.close();
  });

note
  .command("list")
  .description("List the notes of the current repository")
  .option("--all", "include retired and pending notes")
  .option("-r, --repo <path>", "repository (default: the current one)")
  .action(async (o: { all?: boolean; repo?: string }) => {
    const store = await openStore();
    const items = store.list({ repo: repoOf(o.repo), ...(o.all ? {} : { status: "active" as const }) });
    if (!items.length) console.log("No notes yet. Add one with: bifrost note add \"<text>\" --at <path>");
    items.forEach(printItem);
    store.close();
  });

note
  .command("edit <id>")
  .description("Change a note's text, type or anchor")
  .option("--text <text>")
  .addOption(typeOption())
  .option("-a, --at <anchor>")
  .action(async (id: string, o: { text?: string; type?: ItemType; at?: string }) => {
    const store = await openStore();
    printItem(store.edit(id, { ...(o.text ? { text: o.text } : {}), ...(o.type ? { type: o.type } : {}), ...(o.at ? { anchor: parseAnchor(o.at) } : {}) }));
    store.close();
  });

note
  .command("retire <id>")
  .description("Stop showing a note; it stays as history")
  .option("--reason <text>")
  .action(async (id: string, o: { reason?: string }) => {
    const store = await openStore();
    printItem(store.retire(id, o.reason));
    store.close();
  });

note
  .command("import <file>")
  .description("Import notes from a JSON file in the experiment kit's format")
  .option("-r, --repo <path>", "repository (default: the current one)")
  .action(async (file: string, o: { repo?: string }) => {
    const { readKitNotes } = await import("./store/import.js");
    const store = await openStore();
    const items = readKitNotes(file, repoOf(o.repo));
    for (const i of items) store.add(i);
    console.log(`Imported ${items.length} notes.`);
    store.close();
  });

const daemon = program.command("daemon").description("The local process that answers hooks");

daemon
  .command("run")
  .description("Run in the foreground")
  .action(async () => {
    const { startDaemon } = await import("./daemon/server.js");
    try {
      const d = await startDaemon();
      const stop = () => d.close().then(() => process.exit(0));
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      console.log(`bifrost daemon on 127.0.0.1:${d.port}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") {
        console.log("A bifrost daemon is already running.");
        return;
      }
      throw err;
    }
  });

daemon
  .command("start")
  .description("Start in the background")
  .action(async () => {
    const { callDaemon, startDaemonDetached } = await import("./daemon/client.js");
    if ((await callDaemon("/session", null, { timeoutMs: 300 })) !== null) return console.log("Already running.");
    await startDaemonDetached(CLI_PATH);
    console.log("Started.");
  });

daemon
  .command("stop")
  .action(() => {
    const info = readDaemonInfo();
    if (!info) return console.log("Not running.");
    try {
      process.kill(info.pid, "SIGTERM");
      console.log(`Stopped ${info.pid}.`);
    } catch {
      console.log("Not running.");
    }
  });

daemon
  .command("status")
  .action(async () => {
    const info = readDaemonInfo();
    if (!info) return console.log("Not running.");
    try {
      const res = await fetch(`http://127.0.0.1:${info.port}/health`, { headers: { "x-bifrost": "1" }, signal: AbortSignal.timeout(500) });
      const h = (await res.json()) as { version: string; pid: number };
      console.log(`Running: pid ${h.pid}, port ${info.port}, version ${h.version}, store ${info.store}`);
    } catch {
      console.log(`Not responding (last seen pid ${info.pid} on port ${info.port}).`);
    }
  });

program
  .command("hook <client> <event>")
  .description("Entry point for agent client hooks; reads the client's JSON on stdin")
  .action(async (client: string, event: string) => {
    const { runHook } = await import("./clients/hook.js");
    await runHook(client, event, CLI_PATH);
  });

program
  .command("install <client>")
  .description("Set up delivery for a client: opencode, claude-code, codex, cursor")
  .option("--project", "configure the current repository instead of your user settings")
  .action(async (client: string, o: { project?: boolean }) => {
    const { install } = await import("./clients/install.js");
    for (const line of install(client, { cliPath: CLI_PATH, scope: o.project ? "project" : "user", cwd: process.cwd() })) console.log(line);
  });

program
  .command("log")
  .description("What agents were shown recently")
  .option("-s, --session <id>")
  .option("-n, --limit <n>", "how many", "20")
  .action(async (o: { session?: string; limit: string }) => {
    const store = await openStore();
    for (const d of store.deliveries({ ...(o.session ? { session: o.session } : {}), limit: Number(o.limit) }).reverse()) {
      if (!d.shown.length && d.event === "tool") continue;
      console.log(`${d.at}  ${d.client}  ${d.session.slice(0, 12)}  ${d.event === "session" ? "session start" : `${d.tool} ${d.places.join(", ")}`}  → ${d.shown.join(", ") || "-"}`);
    }
    store.close();
  });

program.parseAsync().catch((err: Error) => {
  console.error(`bifrost: ${err.message}`);
  process.exit(1);
});
