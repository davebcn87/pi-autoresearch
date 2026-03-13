# pi-autoresearch — autonomous experiment loop for pi

**[Install](#install)** · **[Usage](#usage)** · **[How it works](#how-it-works)**

*Try an idea, measure it, keep what works, discard what doesn't, repeat forever.*

Inspired by [karpathy/autoresearch](https://github.com/karpathy/autoresearch). Works for any optimization target: test speed, bundle size, LLM training, build times, Lighthouse scores.

---

![pi-autoresearch dashboard](pi-autoresearch.png)

---

## What's included

| | |
|---|---|
| **Extension** | Tools + live widget + `/autoresearch` dashboard |
| **Skill** | Gathers what to optimize, writes session files, starts the loop |

### Extension tools

| Tool | Description |
|------|-------------|
| `init_experiment` | One-time session config — name, metric, unit, direction, optional `reset_policy` |
| `run_experiment` | Runs any command, times wall-clock duration, captures output |
| `log_experiment` | Records result, auto-commits, updates widget and dashboard |

### UI

- **Status widget** — always visible above the editor: `🔬 autoresearch 12 runs 8 kept │ best: 42.3s`
- **`/autoresearch`** — full results dashboard (`Ctrl+X` to toggle, `Escape` to close)

### Skill

`autoresearch-create` asks a few questions (or infers from context) about your goal, command, metric, and files in scope — then writes two files and starts the loop immediately:

| File | Purpose |
|------|---------|
| `autoresearch.md` | Session document — objective, metrics, files in scope, what's been tried. A fresh agent can resume from this alone. |
| `autoresearch.sh` | Benchmark script — pre-checks, runs the workload, outputs `METRIC name=number` lines. |
| `autoresearch.checks.sh` | *(optional)* Backpressure checks — tests, types, lint. Runs after each passing benchmark. Failures block `keep`. |

---

## Install

```bash
pi install https://github.com/davebcn87/pi-autoresearch
```

<details>
<summary>Manual install</summary>

```bash
cp -r extensions/pi-autoresearch ~/.pi/agent/extensions/
cp -r skills/autoresearch-create ~/.pi/agent/skills/
```

Then `/reload` in pi.

</details>

---

## Usage

### 1. Start autoresearch

```
/skill:autoresearch-create
```

The agent asks about your goal, command, metric, and files in scope — or infers them from context. It then creates a branch, writes `autoresearch.md` and `autoresearch.sh`, runs the baseline, and starts looping immediately.

### 2. The loop

The agent runs autonomously: edit → commit → `run_experiment` → `log_experiment` → keep or revert → repeat. It never stops unless interrupted.

`init_experiment` also accepts an optional `reset_policy` for short-context models:

- `nothing` — default. Keep the current behavior and resume in the same session.
- `on_exhaustion` — if the loop ends unexpectedly, start a fresh session and resume from `autoresearch.md`.
- `on_finish` — after every `log_experiment`, start a fresh session before the next experiment.

If you use `on_finish`, keep `autoresearch.md` and `autoresearch.ideas.md` current before `log_experiment`, because the next iteration will start from disk.

Every result is appended to `autoresearch.jsonl` in your project — one line per run. This means:

- **Survives restarts** — the agent can resume a session by reading the file
- **Survives context resets** — `autoresearch.md` captures what's been tried so a fresh agent has full context
- **Human readable** — open it anytime to see the full history
- **Branch-aware** — each branch has its own session

### 3. Monitor progress

- **Widget** — always visible above the editor
- **`/autoresearch`** — full dashboard with results table and best run
- **`Escape`** — interrupt anytime and ask for a summary

---

## Example domains

| Domain | Metric | Command |
|--------|--------|---------|
| Test speed | seconds ↓ | `pnpm test` |
| Bundle size | KB ↓ | `pnpm build && du -sb dist` |
| LLM training | val_bpb ↓ | `uv run train.py` |
| Build speed | seconds ↓ | `pnpm build` |
| Lighthouse | perf score ↑ | `lighthouse http://localhost:3000 --output=json` |

---

## How it works

The **extension** is domain-agnostic infrastructure. The **skill** encodes domain knowledge. This separation means one extension serves unlimited domains.

```
┌──────────────────────┐     ┌──────────────────────────┐
│  Extension (global)  │     │  Skill (per-domain)       │
│                      │     │                           │
│  run_experiment      │◄────│  command: pnpm test       │
│  log_experiment      │     │  metric: seconds (lower)  │
│  widget + dashboard  │     │  scope: vitest configs    │
│                      │     │  ideas: pool, parallel…   │
└──────────────────────┘     └──────────────────────────┘
```

Two files keep the session alive across restarts and context resets:

```
autoresearch.jsonl   — append-only log of every run (metric, status, commit, description)
autoresearch.md      — living document: objective, what's been tried, dead ends, key wins
```

A fresh agent with no memory can read these two files and continue exactly where the previous session left off.

---

## Backpressure checks (optional)

Create `autoresearch.checks.sh` to run correctness checks (tests, types, lint) after every passing benchmark. This ensures optimizations don't break things.

```bash
#!/bin/bash
set -euo pipefail
pnpm test --run
pnpm typecheck
```

**How it works:**

- If the file doesn't exist, everything behaves exactly as before — no changes to the loop.
- If it exists, it runs automatically after every benchmark that exits 0.
- Checks execution time does **not** affect the primary metric.
- If checks fail, the experiment is logged as `checks_failed` (same behavior as a crash — no commit, revert changes).
- The `checks_failed` status is shown separately in the dashboard so you can distinguish correctness failures from benchmark crashes.
- Checks have a separate timeout (default 300s, configurable via `checks_timeout_seconds` in `run_experiment`).

---

## License

MIT
