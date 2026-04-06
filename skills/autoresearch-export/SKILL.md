---
name: autoresearch-export
context: fork
description: Export autoresearch session data through pluggable exporter scripts. Use when asked to "export autoresearch", "publish results", "deploy preview", or "share session".
---

# Autoresearch Export

Pipe session data through pluggable exporter scripts. Each exporter decides where the data goes — a markdown report, a dashboard, a webhook, anything.

## Trigger modes

Exporters declare when they run via `exporter.json`:

| Trigger | When |
|---------|------|
| `always` | After every `log_experiment` call |
| `keep` | Only after a kept experiment |
| `export` | Only on explicit `/skill:autoresearch-export` or session end |

## Search path

The skill discovers exporters from three directories, in order:

```
1. ./autoresearch-exporters/             ← project-local
2. ~/.pi/agent/autoresearch-exporters/   ← user-installed
3. <skill-dir>/exporters/                ← bundled defaults
```

Each directory contains subdirectories — one per exporter:

```
autoresearch-exporters/
├── my-exporter/
│   ├── exporter.json
│   └── export.sh
```

Duplicates by name: first match wins (project-local overrides user-installed overrides bundled).

## Exporter contract

### Manifest: `exporter.json`

```json
{
  "name": "markdown",
  "description": "Append a formatted session report to autoresearch-report.md",
  "trigger": "export",
  "run": "export.sh"
}
```

### Script

The script declared in `run` receives session JSON on stdin. Exit 0 = success, non-zero = failure (does not block other exporters).

### stdin JSON shape

```json
{
  "session": {
    "name": "Optimizing liquid parse+render",
    "metric_name": "total_µs",
    "metric_unit": "µs",
    "direction": "lower",
    "baseline": 18200,
    "best": 8500,
    "improvement_pct": 53.3,
    "total_runs": 42,
    "kept": 12,
    "discarded": 28,
    "crashed": 2
  },
  "results": [],
  "keeps": [],
  "context": {
    "branch": "autoresearch/liquid-perf-20260320",
    "repo": "org/my-project",
    "autoresearch_md": "..."
  }
}
```

## Workflow

### Step 1 — Build session payload

1. Read `autoresearch.jsonl` — parse the config header and all result lines.
2. Read `autoresearch.md` for context.
3. Compute session summary: baseline (first result metric), best (best kept metric), improvement_pct, counts by status.
4. Get branch name from `git branch --show-current`.
5. Get repo from `git remote get-url origin` (extract org/repo).

### Step 2 — Discover exporters

Scan the search path directories. For each subdirectory containing an `exporter.json`:
- Parse the manifest.
- Validate required fields: `name`, `trigger`, `run`.
- Skip if an exporter with the same name was already found (first match wins).

### Step 3 — Filter by trigger

Determine which trigger mode applies:
- If invoked as part of `log_experiment` with status `keep` → run `always` + `keep` exporters.
- If invoked as part of `log_experiment` with any other status → run `always` exporters only.
- If invoked explicitly via `/skill:autoresearch-export` → run `export` exporters.
- If invoked with `--all` → run all exporters regardless of trigger.
- If invoked with a name argument (e.g. `preview`) → run only that exporter.

### Step 4 — Run exporters

For each matched exporter:
1. Serialize the session payload to JSON.
2. Pipe it to the exporter script via stdin: `echo "$JSON" | bash <exporter-dir>/<run-script>`
3. Set `EXPORTER_DIR` env var to the exporter's directory (so scripts can reference sibling files like templates).
4. Capture exit code. Log success or failure.
5. Continue to next exporter regardless of result.

### Step 5 — Report

Show the user which exporters ran and their results:

```
Exported via 2 exporters:
  ✓ markdown — wrote autoresearch-report.md
  ✗ slack — failed (exit 1): missing SLACK_WEBHOOK_URL
```
