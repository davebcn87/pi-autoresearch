---
name: autoresearch-create
description: Set up and run an autonomous experiment loop for any optimization target. Gathers what to optimize, then starts the loop immediately. Use when asked to "run autoresearch", "optimize X in a loop", "set up autoresearch for X", or "start experiments".
---

# Autoresearch

Autonomous experiment loop: try ideas, keep what works, discard what doesn't, never stop.

## Tools

- **`init_experiment`** — configure session (name, metric, unit, direction). Call again to re-initialize with a new baseline when the optimization target changes.
- **`run_experiment`** — runs `.auto/measure.sh` (default) + `.auto/checks.sh`, parses `METRIC`/`TIMING`, auto-decides `keep`/`discard`/`crash`/`checks_failed`, commits or reverts code, and commits `.auto/` learnings in one call. Pass `description` + optional `hypothesis`, `prev_learning`, `keep_on_tie`, `revisits_run`, or `asi`. Fullscreen dashboard: `/autoresearch dashboard`.

## Session files

All session files live in a single `.auto/` subfolder at the working directory root. This keeps everything in one place — easy to preserve across reverts, gitignore, and clean up.

| File | Purpose |
|------|---------|
| `.auto/prompt.md` | Experiment prompt / playbook (heart of the session) |
| `.auto/measure.sh` | Benchmark script — emits `METRIC name=value` lines |
| `.auto/log.jsonl` | Append-only result log (written by the tools) |
| `.auto/ideas.md` | Ideas backlog (optional) |
| `.auto/checks.sh` | Correctness checks (optional) |
| `.auto/config.json` | Session config (optional) |
| `.auto/hooks/{before,after}.sh` | Lifecycle hooks (optional) |

> Always create files in the `.auto/` layout. Legacy flat `autoresearch.*` files are still read for in-flight sessions, but new sessions should use `.auto/`.

## Setup

1. Ask (or infer) the **Goal** and primary **Metric** (+ unit/direction), then **call `init_experiment` immediately**. This must precede implementation, optimization, lengthy source exploration, or any benchmark attempt. Do not wait until the system works or a baseline exists. Never replace the experiment tools with handwritten logs or shell-only experiment loops; if the tools are missing, report the activation problem rather than silently proceeding.
2. Infer **Command**, **Files in scope**, and **Constraints**. Create `autoresearch/<goal>-<date>` if needed, preserving existing user work.
3. Read enough source to define a representative benchmark. Write `.auto/prompt.md`, `.auto/measure.sh`, and required `.auto/checks.sh`; checkpoint the initial state before potentially reverting failed runs. For a from-scratch implementation, keep every build/validation attempt visible in the tool-managed loop while bringing it up.
4. Call `run_experiment` for every attempt. Crashes and check failures are logged and auto-reverted; neither establishes a baseline. If a passing command omits `METRIC <primary>=<number>`, fix the script output format and re-run. **The first successful run** automatically establishes the baseline.
5. Optimize relative to that baseline and continue the tool-managed loop immediately.

### `.auto/prompt.md`

This is the heart of the session. A fresh agent with no context should be able to read this file and run the loop effectively. Invest time making it excellent.

```markdown
# Autoresearch: <goal>

## Objective
<Specific description of what we're optimizing and the workload.>

## Metrics
- **Primary**: <name> (<unit>, lower/higher is better) — the optimization target
- **Secondary**: <name>, <name>, ... — independent tradeoff monitors

## How to Run
`./.auto/measure.sh` — outputs `METRIC name=number` lines.

## Files in Scope
<Every file the agent may modify, with a brief note on what it does.>

## Off Limits
<What must NOT be touched.>

## Constraints
<Hard rules: tests must pass, no new deps, etc.>

## What's Been Tried
<Update this section as experiments accumulate. Note key wins, architectural
insights, and discarded ideas: why they failed and what would justify revisiting them.>
```

Update `.auto/prompt.md` periodically — especially the "What's Been Tried" section — so resuming agents have full context.

### `.auto/measure.sh`

Bash script (`set -euo pipefail`) that: pre-checks fast (syntax errors in <1s), runs the benchmark, and outputs structured lines to stdout. Keep the script fast — every second is multiplied by hundreds of runs.

**For fast, noisy benchmarks** (< 5s), run the workload multiple times inside the script and report the median. This produces stable data points and makes the confidence score reliable from the start. Slow workloads (ML training, large builds) don't need this — single runs are fine.

#### Structured output

- `METRIC name=value` — primary metric (must match `init_experiment`'s `metric_name`) and any secondary metrics. Parsed automatically by `run_experiment`.
- **Optional timing:** emit `TIMING start build` / `TIMING end build`, and similarly for `benchmark`, `load`, etc. Names use letters/digits/`_.:/-`, up to 80 characters; nested/repeated spans work. An optional final Unix timestamp in **milliseconds** avoids stdout-buffering artifacts. Otherwise receipt time is used; flush output for precision. Incomplete/invalid spans are advisory, not benchmark failures. Do not use reserved names `run_experiment`, `checks`, or `agent/other`. The tool always emits its own `run_experiment` start/end timing; instrument only useful subdivisions inside the benchmark command.
- Full-loop time, command/check wall time, and the longest measured exclusive step are saved automatically by `run_experiment` and shown in the dashboard. `agent/other` is unattributed wall time (reasoning, editing, other tools, etc.), not a measurement of inference alone. Use this feedback to reduce iteration overhead as well as optimize the target. Timing is optional; never delay initialization or baseline measurement to add it.
- Reinitializing a baseline preserves a dimmed comparison against the first successful baseline with the same metric name/unit/direction. Retain earlier attempts; do not reset history to improve reported progress.

#### Design the script to inform optimization

The script should output **whatever data helps you make better decisions in the next iteration.** Think about what you'll need to see after each run to know where to focus:

- Phase timings when the workload has distinct stages
- Error counts, failure categories, or test names when checks can fail in different ways
- Memory usage, cache hit rates, or other runtime diagnostics when relevant
- Anything domain-specific that would help localize regressions or identify bottlenecks

The script runs the same code every iteration — but you can **update it during the loop** if you discover you need more signal. Add instrumentation as you learn what matters.

#### Capturing learnings via `run_experiment`

Pass `hypothesis` (before running) and `prev_learning` (takeaway from the previous run's output) or `asi` on `run_experiment` to preserve what you learned across reverts and compactions.

**Annotate failures and crashes heavily.** Discarded and crashed runs are reverted — the code changes are gone. The only record that survives is the description and ASI in `.auto/log.jsonl`. If you don't capture what you tried and why it failed, future iterations will waste time re-discovering the same dead ends.

### `.auto/config.json` (optional)

JSON config file that lives in `.auto/` under the pi session's working directory (`ctx.cwd`). Supported fields:

- **`maxIterations`** (number) — maximum experiments before auto-stopping.
- **`compactEvery`** (number) — optional periodic deterministic compaction cadence (every N logged experiments, emit a lossless persisted-state compaction boundary with `firstKeptEntryId: null`).
- **`compactAtPercent`** (number | `false`) — context-window % ceiling for deterministic compaction between experiments (default `70`). Set `0` or `false` to disable (or set `compactAtTokens` for an absolute token cap).
- **`workingDir`** (string) — override the directory for all autoresearch operations: file I/O (`.auto/log.jsonl`, `.auto/prompt.md`, `.auto/measure.sh`, `.auto/checks.sh`, `.auto/ideas.md`), command execution, and git operations. Supports absolute paths or relative paths (resolved against `ctx.cwd`). The config file itself always stays under `ctx.cwd`. Fails if the directory doesn't exist.

```json
{
  "workingDir": "/path/to/project",
  "maxIterations": 50
}
```

### `.auto/checks.sh` (optional)

Bash script (`set -euo pipefail`) for backpressure/correctness checks: tests, types, lint, etc. **Only create this file when the user's constraints require correctness validation** (e.g., "tests must pass", "types must check").

When this file exists:
- Runs automatically after every **passing** benchmark in `run_experiment`.
- If checks fail, `run_experiment` reports it clearly — log as `checks_failed`.
- Its execution time does **NOT** affect the primary metric.
- You cannot `keep` a result when checks have failed.
- Has a separate timeout (default 300s, configurable via `checks_timeout_seconds`).

When this file does **not** exist, everything behaves exactly as before — no changes to the loop.

**Keep output minimal.** Only the last 80 lines of checks output are fed back to the agent on failure. Suppress verbose progress/success output and let only errors through. This keeps context lean and helps the agent pinpoint what broke.

```bash
#!/bin/bash
set -euo pipefail
# Example: run tests and typecheck — suppress success output, only show errors
pnpm test --run --reporter=dot 2>&1 | tail -50
pnpm typecheck 2>&1 | grep -i error || true
```

## Loop Rules

**LOOP FOREVER.** Never ask "should I continue?" — the user expects autonomous work.

- **Primary metric is king.** Improved → `keep`. Worse/equal → `discard`. Secondary metrics rarely affect this.
- **Annotate every run with `asi`.** Record what you learned — not what you did. What would help the next iteration or a fresh agent resuming this session?
- **Watch marginal confidence.** On `keep`, `run_experiment` reports marginal confidence (gain over previous best vs. local noise floor). <1.0× means the marginal bump is within noise — consider a verification rerun.
- **Simpler is better.** Removing code for equal perf = keep. Ugly complexity for tiny gain = probably discard.
- **Don't thrash.** Repeatedly reverting the same idea? Try something structurally different.
- **Crashes:** fix if trivial, otherwise log and move on. Don't over-invest.
- **Think longer when stuck.** Re-read source files, study the profiling data, reason about what the CPU is actually doing. The best ideas come from deep understanding, not from trying random variations.
- **Resuming:** if `.auto/prompt.md` exists, read it + git log. If no tool-managed config exists, call `init_experiment` immediately; otherwise preserve it. If only failed runs exist, keep attempting until the first successful run establishes the baseline. Continue looping without erasing earlier failures.

**NEVER STOP unless interrupted or native recovery is exhausted.** The user may be away for hours. Keep going, but respect Esc/user abort: the extension persistently pauses and requires explicit `/autoresearch resume` or `/autoresearch <context>`. Do not undo that pause, reactivate the loop, or schedule a replacement prompt. Pi owns transient LLM retries/backoff and automatic compaction; do not create an extension/shell retry loop or inject “continue” messages. Unrecoverable/exhausted errors and manual `/compact` leave the session paused.

## Ideas Backlog

When you discover complex but promising optimizations that you won't pursue right now, **append them as bullets to `.auto/ideas.md`**. Don't let good ideas get lost.

On resume (context limit, crash), check `.auto/ideas.md` — prune stale/tried entries, experiment with the rest. When all paths are exhausted, delete the file and write a final summary.

## User Messages During Experiments

If the user sends a message while an experiment is running, let the current `run_experiment` finish first, then incorporate their feedback in the next iteration. Don't abandon a running experiment.
