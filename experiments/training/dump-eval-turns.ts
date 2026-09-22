#!/usr/bin/env node
/**
 * Dump eval-turn corpora as {session, text} JSONL for scripts/eval-dapt.py.
 * Run on the worker VM (needs the gateway tree + data, no API keys).
 *
 * Usage: node --import tsx scripts/dump-eval-turns.ts [fixture|trajfixtures|real|swe|all]
 */
import { createWriteStream, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createApp, closeApp } from "../src/app.js";

async function dumpFixture() {
  const { FIXTURE_SESSIONS } = await import("../tests/fixtures/corpus.js");
  const out = createWriteStream("swe-data/eval-turns-fixture.jsonl");
  let n = 0;
  for (const s of FIXTURE_SESSIONS) {
    for (const t of s.turns) {
      if (t.content.trim().length >= 20) {
        out.write(JSON.stringify({ session: s.id, text: t.content.slice(0, 2000) }) + "\n");
        n++;
      }
    }
  }
  out.end();
  await new Promise((r) => out.on("finish", r));
  console.log("fixture turns:", n);
}

async function dumpTrajFixtures() {
  const { TrajectoryAdapter } = await import("../src/adapters/trajectories.js");
  const a = new TrajectoryAdapter(join(process.cwd(), "tests", "fixtures", "trajectories"));
  const out = createWriteStream("swe-data/eval-turns-trajfixtures.jsonl");
  let n = 0;
  for (const s of await a.listSessions()) {
    for (const t of await a.listTurns(s.id)) {
      if (t.content.trim().length >= 20) {
        out.write(JSON.stringify({ session: s.id, text: t.content.slice(0, 2000) }) + "\n");
        n++;
      }
    }
  }
  out.end();
  await new Promise((r) => out.on("finish", r));
  console.log("trajfixture turns:", n);
}

async function dumpReal() {
  process.env.CONTEXT_GATEWAY_STATE = "swe-data/real-state";
  const app = createApp({
    indexDir: "swe-data/real-index",
    claudeDir: "swe-data/real-claude",
    codexDir: "swe-data/real-codex",
    trajectoryDir: "swe-data/empty-traj",
  });
  const { listSessions } = await import("../src/commands.js");
  const out = createWriteStream("swe-data/eval-turns-real.jsonl");
  let n = 0;
  for (const s of await listSessions(app, {})) {
    const a = app.adapters.find((x) => x.harness === s.harness);
    if (!a) continue;
    for (const t of await a.listTurns(s.id).catch(() => [])) {
      if (t.content?.trim().length >= 20) {
        out.write(JSON.stringify({ session: s.id, text: t.content.slice(0, 2000) }) + "\n");
        n++;
      }
    }
  }
  out.end();
  await new Promise((r) => out.on("finish", r));
  closeApp(app);
  console.log("real turns:", n);
}

async function dumpSwe() {
  const out = createWriteStream("swe-data/eval-turns-swe.jsonl");
  let n = 0;
  for (const f of readdirSync("swe-data/swe-gym").filter((x) => x.endsWith(".json"))) {
    const doc = JSON.parse(readFileSync(join("swe-data/swe-gym", f), "utf8"));
    const sid = doc.instance_id;
    for (const s of doc.steps ?? []) {
      for (const k of ["thought", "action", "observation"]) {
        const v = typeof s[k] === "string" ? s[k].trim() : "";
        if (v.length >= 20) {
          out.write(JSON.stringify({ session: sid, text: v.slice(0, 2000) }) + "\n");
          n++;
        }
      }
    }
  }
  out.end();
  await new Promise((r) => out.on("finish", r));
  console.log("swe turns:", n);
}

async function main() {
  mkdirSync("swe-data", { recursive: true });
  const which = process.argv[2] ?? "all";
  if (which === "all" || which === "fixture") await dumpFixture();
  if (which === "all" || which === "trajfixtures") await dumpTrajFixtures();
  if (which === "all" || which === "real") await dumpReal();
  if (which === "all" || which === "swe") await dumpSwe();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
