# Configuration

pi-autoresearch has deliberately few knobs. Configure where and how a session runs; keep the experiment protocol consistent.

## Session configuration

The optional `.auto/config.json` file lives under the Pi session directory. Paths resolve from the directory where Pi was started.

```json
{
  "workingDir": "../project",
  "maxIterations": 30
}
```

| Setting | Type | Behavior |
| --- | --- | --- |
| `workingDir` | string | Runs file operations, Git, hooks, and experiments in another existing directory. Relative paths resolve from the Pi session directory. |
| `maxIterations` | number | Stops the active segment after this many logged experiments. Start a new segment to continue. |

> **Important:** The config file remains in the session directory even when `workingDir` points elsewhere.

## Session files

The create skill writes the two required files. Add ideas, checks, and hooks only when the session needs them.

| File | Status | Purpose |
| --- | --- | --- |
| `.auto/prompt.md` | Generated | Objective, metric, scope, constraints, tried ideas, dead ends, and useful findings. This is the handoff across context resets. |
| `.auto/measure.sh` | Generated | Runs the benchmark and prints one or more `METRIC name=number` lines. |
| `.auto/log.jsonl` | Managed | Append-only session history. Do not hand-edit it while a session is running. |
| `.auto/ideas.md` | Optional | A backlog for promising optimizations that are too complex or distracting to pursue immediately. Resuming agents prune tried ideas and experiment with what remains. |
| `.auto/checks.sh` | Optional | Tests, type checks, or lint that run after a passing benchmark. A failure blocks the keep without changing the measured metric. |
| `.auto/hooks/before.sh` | Optional | Receives session JSON before the next iteration. Stdout becomes a steer message for the agent. |
| `.auto/hooks/after.sh` | Optional | Receives the completed run and session snapshot. Useful for journals, notifications, or tagging. |

## Runtime options

Timeouts belong to the `run_experiment` call, not `config.json`.

```js
run_experiment({
  command: "pnpm test --run",
  timeout_seconds: 600,
  checks_timeout_seconds: 300
})
```

- **`command`** — The benchmark command. Required.
- **`timeout_seconds`** — Benchmark timeout. Defaults to 600 seconds.
- **`checks_timeout_seconds`** — Separate timeout for `.auto/checks.sh`. Defaults to 300 seconds.

## Safety and trust

Pi packages run with your full user permissions. Review this repository before installing it, and run autoresearch in a dedicated branch or worktree with a clean working tree.

Autoresearch edits files, creates and reverts commits, and executes `.auto/measure.sh`, `.auto/checks.sh`, and scripts under `.auto/hooks/`. Review those files before each session, keep credentials and sensitive files out of scope, and use a sandbox or restricted environment for untrusted projects.

For reproducible installs, pin a version you have reviewed, for example:

```bash
pi install npm:pi-autoresearch@1.7.0
```

Published npm releases include provenance attestations. Provider-side spending limits and `maxIterations` can bound the cost of an unattended session.

## Keyboard shortcuts (opt-in)

No shortcuts are bound by default. Every action is available through an `/autoresearch` subcommand, avoiding conflicts with pi's built-in keymap.

To opt in, create `<agent-dir>/extensions/pi-autoresearch.json`. The agent directory is normally `~/.pi/agent`, or `PI_CODING_AGENT_DIR` when set.

```json
{
  "shortcuts": {
    "fullscreenDashboard": "ctrl+shift+y",
    "export": "alt+shift+e",
    "off": null
  }
}
```

Omitted or `null` settings remain unbound. `fullscreenDashboard` runs `/autoresearch dashboard`, `export` runs `/autoresearch export`, and `off` runs `/autoresearch off`. Verify that each chord is free in the installed pi keymap and your `<agent-dir>/keybindings.json`; extension shortcuts win conflicts.

## Hooks

Executable scripts under `.auto/hooks/` can observe or influence iteration boundaries without adding hook logic to the research prompt.

`before.sh` → **Experiment: edit, measure, log** → `after.sh` → **next iteration**

### Lifecycle

- **`.auto/hooks/before.sh`** runs on fresh activation, then again after each logged experiment. Use it to fetch research, rotate ideas, or prepare context for the next attempt.
- **`.auto/hooks/after.sh`** runs after `log_experiment`. Use it to persist learnings, tag wins, or send local notifications.

### Contract

- **Input:** A single JSON object on stdin containing the event, working directory, run data, and session snapshot.
- **Output:** Stdout becomes a steer message for the agent. Empty stdout is silent. Output is capped at 8 KB.
- **Failure:** A non-zero exit or execution longer than 30 seconds produces an error steer instead of stopping the extension.
- **History:** Every hook execution appends a `type: "hook"` entry to `.auto/log.jsonl`.
- **Reverts:** The entire `.auto/` directory, including hooks, survives discarded experiments.

### Minimal after hook

```bash
#!/usr/bin/env bash
set -euo pipefail

run="$(jq -r '.run_entry.run' <&0)"
printf 'Run %s logged. Review the result before repeating.\n' "$run"
```

Make hook files executable before starting the session:

```bash
chmod +x .auto/hooks/before.sh .auto/hooks/after.sh
```

> **Fixed boundary:** Hook names, the 30-second timeout, and the 8 KB stdout limit are not configurable. The agent has no dedicated hook field; scripts mine the same descriptions and `asi.*` signals the loop already records.

## Session controls

- **`/autoresearch <text>`** — Start a new session or resume an existing one with additional context.
- **`/autoresearch off`** — Stop auto-resume while preserving the session history.
- **`/autoresearch clear`** — Delete the log and reset runtime state for a clean start.
- **`/autoresearch export`** — Open the live browser dashboard and export a shareable result image.
- **`/autoresearch dashboard`** — Open the fullscreen, scrollable dashboard in the terminal.

## Intentionally fixed behavior

These constraints keep results comparable and sessions recoverable.

- **Primary metric decides.** Keep or discard follows the configured primary metric. Secondary metrics are monitoring signals, not a weighted score.
- **Confidence is advisory.** The Median Absolute Deviation estimator and 1× / 2× guidance thresholds are fixed. Confidence never auto-discards a run.
- **State lives under `.auto/`.** The folder name and JSONL record format are part of the extension contract. Legacy files are read only for compatibility.
- **Hooks have a fixed boundary.** Only `before.sh` and `after.sh` are recognized. They receive JSON on stdin and return steer text on stdout.
- **Safety guards remain internal.** Auto-resume turn and consecutive-failure guards are not tuning knobs.
- **Dashboard presentation is not themed per session.** Browser and terminal dashboards follow the extension UI rather than session-level style configuration.

## Start with the defaults

Add configuration only when the experiment requires a different boundary.

[Back to pi-autoresearch →](index.html)
