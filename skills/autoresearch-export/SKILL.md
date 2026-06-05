---
name: autoresearch-export
context: fork
description: Export autoresearch session data through pluggable exporter scripts. Use when asked to "export autoresearch", "publish results", or "share session".
---

# Autoresearch Export

Pipe session data through pluggable exporter scripts. Each exporter decides where the data goes — a markdown report, a database, a dashboard, anything.

## When to run

At the end of an autoresearch session, or on explicit `/skill:autoresearch-export`. This is intentionally a one-time export, not a per-run hook — the LLM has the full picture of the session and can reason about what's worth exporting.

## Curating before export

Before running the export, review the session:

1. Read `autoresearch.jsonl` and `autoresearch.md`.
2. Look at the full history — keeps, discards, crashes.
3. Identify what's actually worth recording:
   - Skip noise (tiny improvements within the noise floor).
   - Skip superseded keeps (early keep replaced by a better version later).
   - Note dead ends — "tried X, made things worse" is valuable knowledge too.
   - Consider what the user kept vs discarded — some agent keeps are too complex or wrong.
4. Write a curated summary into the session payload's `curated_wins` field.

Each win in `curated_wins` should be a generalizable technique, not a commit-level description.

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
  "curated_wins": [],
  "context": {
    "branch": "autoresearch/liquid-perf-20260320",
    "repo": "org/my-project",
    "autoresearch_md": "..."
  }
}
```

### Result object shape

Each entry in `results` and `keeps`:

```json
{
  "commit": "abc1234",
  "metric": 15200,
  "metrics": { "compile_µs": 4200, "render_µs": 9800 },
  "status": "keep",
  "description": "Switch to lazy initialization for parser",
  "timestamp": 1711000000000,
  "segment": 0,
  "confidence": 2.1
}
```

### Curated win shape

Each entry in `curated_wins` (populated by the LLM before export):

```json
{
  "technique": "Replace linear scan with binary search in sorted data",
  "description": "The hot loop iterated a sorted array linearly. Switching to binary search reduced iterations from O(n) to O(log n). Applies to any sorted-array lookup.",
  "metric_before": 18200,
  "metric_after": 8500,
  "commits": ["abc1234", "def5678"],
  "files": ["lib/parser.rb", "lib/scanner.rb"],
  "dead_ends": ["Tried regex caching — no improvement", "Tried memoizing AST nodes — 2% gain but added complexity"]
}
```

## Workflow

### Step 1 — Curate

Read the full session. Build `curated_wins` as described above. Ask the user to confirm what should be exported.

### Step 2 — Write curated wins

Write the curated wins array to `autoresearch-wins.json`:

```json
[
  {
    "technique": "Replace linear scan with binary search in sorted data",
    "description": "...",
    "metric_before": 18200,
    "metric_after": 8500,
    "commits": ["abc1234"],
    "files": ["lib/parser.rb"],
    "dead_ends": ["Tried regex caching — no improvement"]
  }
]
```

### Step 3 — Build session payload

The script reads `autoresearch.jsonl`, `autoresearch.md`, `autoresearch-wins.json`, and git context to build the payload automatically.

### Step 4 — Discover exporters

Scan the search path directories. For each subdirectory containing an `exporter.json`:
- Parse the manifest.
- Validate required fields: `name`, `run`.
- Skip if an exporter with the same name was already found (first match wins).

### Step 5 — Choose exporters

Show the user the list of discovered exporters with their descriptions. Let the user pick which ones to run. Example:

```
Found 3 exporters:
  1. markdown — Append a formatted session report to autoresearch-report.md
  2. sqlite — Append curated wins to the local SQLite knowledge store
  3. slack — Post session summary to Slack

Which exporters should I run?
```

### Step 6 — Run exporters

For each matched exporter:
1. Serialize the session payload to JSON.
2. Pipe it to the exporter script via stdin.
3. Set `EXPORTER_DIR` and `TRIGGER_MODE` env vars.
4. Capture exit code. Log success or failure.
5. Continue to next exporter regardless of result.

### Step 7 — Report

```
Exported via 2 exporters:
  ✓ markdown — wrote autoresearch-report.md
  ✗ slack — failed (exit 1): missing SLACK_WEBHOOK_URL
```
