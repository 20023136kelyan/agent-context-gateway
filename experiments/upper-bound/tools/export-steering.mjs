#!/usr/bin/env node
/**
 * Exports what you told your coding agents in OpenCode: every message you typed,
 * with the session's folder and the end of the agent reply it answered. Corrections
 * and taste ("no, do it this way", "we always…") are in there; this file is how we
 * find them without you having to search.
 *
 *   node export-steering.mjs            writes bifrost-steering.jsonl in the current folder
 *   node export-steering.mjs --no-context   only your own messages, no agent text
 *
 * Needs `opencode` on PATH. Reads OpenCode's local database through `opencode db`;
 * nothing is sent anywhere. Open the output before sharing it: it contains what you
 * typed, which may include paths, names or secrets.
 */
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const CONTEXT_CHARS = 400;
const withContext = !process.argv.includes("--no-context");
const out = resolve(process.argv.find((a) => a.endsWith(".jsonl")) ?? "bifrost-steering.jsonl");

const SQL = `
select s.id as session, s.directory as dir, s.title as title, m.id as message,
       json_extract(m.data, '$.role') as role, m.time_created as t,
       json_extract(p.data, '$.text') as text, json_extract(p.data, '$.synthetic') as synthetic
from part p
join message m on m.id = p.message_id
join session s on s.id = m.session_id
where json_extract(p.data, '$.type') = 'text' and s.parent_id is null
order by s.time_created, m.time_created, p.time_created`;

const r = spawnSync("opencode", ["db", "--format", "json", SQL], { encoding: "utf8", maxBuffer: 1 << 30, shell: process.platform === "win32" });
if (r.status !== 0) {
  console.error("Could not read the OpenCode database. Is `opencode` installed and on your PATH?\n" + (r.stderr || r.error?.message || ""));
  process.exit(1);
}
const rows = JSON.parse(r.stdout || "[]");

// Join the text parts of each message, then walk each session in order.
const messages = [];
for (const row of rows) {
  const last = messages[messages.length - 1];
  if (last && last.message === row.message) last.text += "\n" + (row.text ?? "");
  else messages.push({ ...row, text: row.text ?? "" });
}

const lines = [];
const sessions = new Set();
let lastAgentText = "";
let currentSession = null;
let turn = 0;
for (const m of messages) {
  if (m.session !== currentSession) {
    currentSession = m.session;
    lastAgentText = "";
    turn = 0;
  }
  if (m.role === "assistant") {
    if (m.text.trim()) lastAgentText = m.text.trim();
    continue;
  }
  if (m.role !== "user" || m.synthetic || !m.text.trim()) continue;
  turn++;
  sessions.add(m.session);
  const entry = { session: m.session, folder: m.dir, title: m.title, at: new Date(m.t).toISOString(), turn, you: m.text.trim() };
  if (withContext && turn > 1 && lastAgentText) entry.agentBefore = lastAgentText.length > CONTEXT_CHARS ? "…" + lastAgentText.slice(-CONTEXT_CHARS) : lastAgentText;
  lines.push(JSON.stringify(entry));
}

writeFileSync(out, lines.join("\n") + (lines.length ? "\n" : ""));
const followUps = lines.filter((l) => JSON.parse(l).turn > 1).length;
console.log(`${lines.length} messages from ${sessions.size} sessions (${followUps} of them follow-ups, where corrections usually are).`);
console.log(`Written to ${out}. Open it before sharing.`);
