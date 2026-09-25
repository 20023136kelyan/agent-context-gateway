# acg-bench: does history search help an agent finish real tasks?

Retrieval metrics say whether the gateway finds the right earlier session.
This asks the question that matters: **given a real task, does an agent with
the gateway finish it faster, cheaper, or more often than the same agent
without it?**

## How a run works

A **suite** is one repository, the agent history recorded while it was built,
and **tasks** replayed from that history (`bench/suites/<name>.json`). Each
task is a real change:

- the agent starts from **`base`**, the commit before the change, with the
  task **prompt**;
- it succeeds when the tests the real change added or changed (**hidden
  tests**, taken from **`gold`**) pass on its tree. They are put in place only
  after the agent stops, over anything it wrote there;
- with the gateway, it sees the history **as it stood at `asOf`**, the moment
  the task was asked (`GATEWAY_AS_OF`), never how the task turned out.

**Arms** differ only in what the agent gets:

| arm | the agent gets |
|---|---|
| `none` | the repository at `base`, with its git log |
| `acg` | the same, plus the gateway's MCP server over the pinned history |
| `acg-hint` | the same as `acg`, plus a one-line workspace rule saying the gateway is there and when to use it |

Each run is isolated, because agents wander. In a probe, an agent looking for
context grepped `~/.claude/projects` (raw transcripts, including what happened
after its task), its own earlier conversations, the real checkout (holding the
commits that solve the task) and the gateway's build. So:

- the workspace is a fresh clone at `base` with every later commit pruned
  (`git log --all` and `git show <gold>` find nothing);
- the agent runs under a macOS sandbox (`sandbox-exec`) that denies the home
  folder except its workspace, its tools' own folders, and the agent's state
  minus its stores of other conversations, and lets it signal only processes
  inside the sandbox;
- the gateway runs outside the sandbox, over a frozen copy of the history,
  reached over loopback HTTP: history reaches the agent only through what the
  gateway returns.

Per run the bench records the agent's timeline from its own event stream:
- model steps, with input, output and thinking tokens;
- tool calls, marked as edits or gateway calls;
- wall time;
- the gateway's own count of calls served;
- the agent's diff;
- the hidden test result.

## Use it

```sh
npx tsx bench/cli.ts tasks                        # the suite
npx tsx bench/cli.ts validate                     # each task: hidden tests fail at base, pass at gold
npx tsx bench/cli.ts run --exp may --repeats 3    # all tasks × none,acg × 3 (resumable)
npx tsx bench/cli.ts run --exp may --arms none,acg,acg-hint --tasks digest-v2
npx tsx bench/cli.ts status --exp may
npx tsx bench/cli.ts report --exp may
npx tsx bench/cli.ts serve                        # http://127.0.0.1:4455, live while runs go
npx tsx bench/cli.ts export --exp may --out may.html   # one self-contained page
```

State lives in `~/.acg-bench` (`ACG_BENCH_HOME`):
- `gateway/`: the build under test;
- `history/`: the frozen snapshot and its index;
- `deps/`: `node_modules` per lockfile;
- `exps/<exp>/runs/<run>/`: `run.json`, `events.jsonl`, `raw.jsonl`, `diff.patch`, `tests.json`.

Workspaces are deleted after each run.

The report compares each gateway arm with `none` over the tasks both ran:
- per task, the median of its repeats;
- across tasks, the geometric mean of the ratios, for time, tokens and tool calls;
- pass counts;
- the same broken down by task category.

## Agents

Pick one with `--agent` (and `--model`).

`agy` (Antigravity CLI, Gemini; the default) is run in print mode with
`--dangerously-skip-permissions` and `--add-dir <workspace>`, and it gets MCP
servers from a plugin inside the workspace (`.agents/plugins/acg/`), so the
user's own agy config is never touched. agy offers MCP tools through one tool,
`call_mcp_tool`, reading each tool's schema from a file first. That is part of
what is measured.

`claude` (Claude Code) runs with `-p --output-format stream-json`, no session
persistence, project settings only, and `--strict-mcp-config` with a config in
the run's folder, so neither the user's MCP servers nor their instructions
reach it. The hint arm writes the hint to the workspace's `CLAUDE.md`. Its
reported cost is kept per run.

A run the model's API cuts short (a usage limit, an outage) says nothing about
the task: it is recorded as an error, left out of the report, and the bench
stops starting new runs. Running the same command again resumes.

Adding an agent means one adapter in `bench/lib/agents.ts`: start it in the
workspace under the sandbox, give it the gateway URL when the arm has one, and
turn its event stream into model steps and tool calls.

## Writing tasks

- Pick a commit whose tests pin its behaviour.
- Set `asOf` to just before the agent first edited the files that commit
  changes, so the discussion that led to it counts as history and the
  implementation does not.
- Write the prompt the way a developer opens a new session: what to change,
  and the names and behaviour the tests check, never how to do it.
- Mark the category honestly:
  - `needs-history`: the prompt leaves out something only the searchable
    history holds;
  - `history-helps`: the code has everything, and the history says where to
    look and why;
  - `control`: history is irrelevant.
- Run `validate`.
