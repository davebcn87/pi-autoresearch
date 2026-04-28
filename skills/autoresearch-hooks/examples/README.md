# Hook examples

Reference scripts for `autoresearch.hooks/before.sh` and `autoresearch.hooks/after.sh`. Each file is a complete, self-contained example — pick the one closest to what you want, copy it to your session's `autoresearch.hooks/` directory, adapt, and mark executable.

These scripts ship with the `autoresearch-hooks` skill. When the skill is active, paths resolve against the skill directory, so the agent can copy them with:

```bash
cp "<skill-dir>/examples/before/external-search.sh" /path/to/session/autoresearch.hooks/before.sh
chmod +x /path/to/session/autoresearch.hooks/before.sh
```

The files here are **not** marked executable on purpose — they're references, not installed hooks. A `chmod +x` step is required when you wire one up.

For the hook contract (stdin schemas, stdout handling, timeouts, observability), see the main [README §Hooks](../../../README.md#hooks-optional).

## `before/` — fires before each iteration

| Script | Purpose |
| --- | --- |
| [`external-search.sh`](before/external-search.sh) | Mine agent notes for a query and fetch external material via your search tool of choice. |
| [`qmd-search.sh`](before/qmd-search.sh) | Same shape, but targets a local [`qmd`](https://www.npmjs.com/package/qmd) BM25 / vector / rerank index over your project's markdown. |
| [`anti-thrash.sh`](before/anti-thrash.sh) | After N consecutive discards, emit a steer suggesting a structural rethink. |
| [`idea-rotator.sh`](before/idea-rotator.sh) | Surface the next unchecked bullet from `autoresearch.ideas.md` as a steer nudge. |
| [`hypothesis-reflection.sh`](before/hypothesis-reflection.sh) | On a discard, ask a cheap model to critique the failed hypothesis and propose adjacent directions. |
| [`context-rotation.sh`](before/context-rotation.sh) | Trim an oversized `autoresearch.md`, archiving the tail. |

## `after/` — fires after each `log_experiment`

| Script | Purpose |
| --- | --- |
| [`learnings-journal.sh`](after/learnings-journal.sh) | Append one human-readable line per run to `autoresearch.learnings.md`. |
| [`macos-notify.sh`](after/macos-notify.sh) | Fire a native macOS banner only when the run is a new best. |
| [`auto-tag-winners.sh`](after/auto-tag-winners.sh) | Tag every new best with a sortable git tag. |

## Style conventions

All examples follow the same structure:

- **Named constants at the top** (`readonly`) — no magic literals
- **Short helper functions** (3–8 lines) for named steps
- **Guard clauses** at the top with early `exit 0`
- **Query vs command separation** — queries return values/booleans, commands mutate
- **Intention-revealing names** — `is_new_best`, `query_from_agent_notes`, `archive_tail`

Adapt freely — these are starting points, not policy.
