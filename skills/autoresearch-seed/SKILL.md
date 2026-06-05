---
name: autoresearch-seed
context: fork
description: Seed an autoresearch session with relevant prior work from the local knowledge store. Use at the start of a session, or when asked to "find prior work", "seed ideas", or "what worked before".
---

# Autoresearch Seed

Search the local knowledge store (`~/.pi/agent/autoresearch.db`) for prior experiments relevant to the current session. Appends a "Prior work" section to `autoresearch.md` so the agent starts with context from past sessions.

## When to run

- Automatically after `autoresearch-create` writes `autoresearch.md` and before the first experiment.
- Manually via `/skill:autoresearch-seed` at any point during a session.

## Workflow

### Step 1 — Read session context

Read `autoresearch.md`. Extract the goal (from the `# Autoresearch: <goal>` heading) and files in scope.

### Step 2 — Search the knowledge store

Run:

```bash
bash <SKILL_DIR>/seed.sh
```

The script:
1. Builds an FTS5 query from the goal text.
2. Queries the local SQLite store, ranked by BM25, limit 10.
3. Groups results by session.
4. Outputs a markdown section to stdout.

If the database doesn't exist or has no results, the script exits 0 with no output. This is expected for first-ever sessions.

### Step 3 — Append to autoresearch.md

If the script produced output, append it to `autoresearch.md` before the "What's Been Tried" section (or at the end if that section doesn't exist).

### Step 4 — Report

Tell the user how many prior sessions and wins were found:

```
Seeded with 3 prior sessions, 7 relevant wins.
```

If nothing was found, say so and move on. Don't block.
