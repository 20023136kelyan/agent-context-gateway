/**
 * Each agent runs under a macOS sandbox (Seatbelt, via sandbox-exec) that
 * lets it read and write its own workspace and little else in the home
 * folder. Without it an agent looking for context wanders: in a probe, agy
 * grepped ~/.claude/projects (raw transcripts, including turns after its
 * task), its own earlier conversations, the real checkout (with the commits
 * that solve the task) and the gateway's build. Any of those voids the
 * comparison, in either arm.
 *
 * Allowed: the run's workspace; the tools' own homes (node, npm cache, git
 * config); the agent's own state, minus the stores that hold other sessions.
 * The gateway runs outside the sandbox and is reached over loopback HTTP, so
 * history reaches the agent only through what it returns. Signals stay inside
 * the sandbox too.
 */
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const q = (p: string) => JSON.stringify(p);

/** What each agent itself needs beyond the workspace: its state, minus the stores that hold other sessions. */
function agentRules(agent: string, home: string): string {
  if (agent === "claude") {
    const c = join(home, ".claude");
    return `; Claude Code: its config, cache and install, and the keychain its login lives in...
(allow file-read* file-write* (subpath ${q(c)}) (regex ${q(`^${home}/\\.claude\\.json`)}))
(allow file-read* (subpath ${q(join(home, ".local", "share", "claude"))}) (subpath ${q(join(home, "Library", "Keychains"))}))
; ...but not transcripts, file snapshots, plans, prompt history, or the user's own instructions, skills and plugins.
(deny file-read* file-write*${["projects", "file-history", "paste-cache", "plans", "sessions", "backups", "skills", "plugins"].map((d) => ` (subpath ${q(join(c, d))})`).join("")}
  (literal ${q(join(c, "history.jsonl"))}) (literal ${q(join(c, "CLAUDE.md"))}))`;
  }
  const agyState = join(home, ".gemini", "antigravity-cli");
  return `; agy: its state and config...
(allow file-read* file-write* (subpath ${q(agyState)}) (subpath ${q(join(home, ".gemini", "config"))}))
; ...but not its stores of other conversations, or anything it could carry between them:
; it runs without them, and a run cannot read another's work.
(deny file-read* file-write*${["brain", "conversations", "annotations", "implicit", "knowledge"].map((d) => ` (subpath ${q(join(agyState, d))})`).join("")}
  (literal ${q(join(agyState, "history.jsonl"))}) (literal ${q(join(agyState, "conversation_summaries.db"))}))`;
}

export function sandboxProfile(workDir: string, agent = "agy", extraDeny: string[] = []): string {
  const home = homedir();
  return `(version 1)
(allow default)
; Signals only within the sandbox: in the pilot an agent tidying "stray" test
; processes killed every node process on the machine, the bench's own too.
(deny signal)
(allow signal (target same-sandbox))
; Nothing in the home folder, and not this machine's other temp trees...
(deny file-read* file-write* (subpath ${q(home)}) (subpath "/private/tmp/claude-501")${extraDeny.map((d) => ` (subpath ${q(d)})`).join("")})
; Looking a path up (stat) is not reading it: without this no folder under home can even be entered.
(allow file-read-metadata (subpath ${q(home)}))
(allow file-read* (literal ${q(home)}))
; ...except what the agent and its tools need to run.
(allow file-read* (subpath ${q(join(home, ".nvm"))}) (subpath ${q(join(home, ".local", "bin"))}) (literal ${q(join(home, ".gitconfig"))}) (literal ${q(join(home, ".npmrc"))}))
(allow file-read* file-write* (subpath ${q(join(home, ".npm"))}))
${agentRules(agent, home)}
; The run's own workspace.
(allow file-read* file-write* (subpath ${q(workDir)}))
`;
}

export function writeSandboxProfile(path: string, workDir: string, agent = "agy"): string {
  writeFileSync(path, sandboxProfile(workDir, agent));
  return path;
}
