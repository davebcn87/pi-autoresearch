# Changelog

All notable changes to this project will be documented in this file.

## [1.4.0] - 2026-05-06

### Added

- Configurable dashboard keyboard shortcuts. Users can now override or disable the toggle and fullscreen shortcuts with a profile-aware `<agent-dir>/extensions/pi-autoresearch.json` config file, helping autoresearch coexist with other pi extensions that bind the same keys.
- Shortcut resolution tests covering defaults, overrides, disabled shortcuts, partial configs, malformed configs, and extension registration.

### Changed

- Dashboard hints and README documentation now reflect the effective shortcuts from config.

## [1.3.0] - 2026-04-29

### Added

- Deterministic compaction summary. When pi compacts context, autoresearch now bypasses the LLM summarization and injects a lossless markdown summary built from persisted state (experiment rules, ideas backlog, and last 50 runs with ASI fields). This eliminates information loss across compaction boundaries.
- Recent-run deltas in the compaction summary use the full segment baseline, not just the first visible run in the window — percentages stay accurate even for long sessions.
- New test coverage for compaction summary assembly, empty state, re-init segments, 50-run cap, and hidden-baseline delta correctness.

### Fixed

- Post-turn auto-resume no longer tells the agent "don't re-read files" when no compaction happened. Split into two resume messages: a generic one for normal turns and a compaction-specific one that correctly references the summary.

## [1.2.0] - 2026-04-28

### Changed

- Long-running loops now ride pi's auto-compaction instead of stopping. When pi summarizes older messages on context overflow, autoresearch detects the resulting idle and re-prompts the agent to re-read `autoresearch.md`, the tail of `autoresearch.jsonl`, `autoresearch.ideas.md`, and `git log` before continuing.

### Fixed

- Manual `/compact` mid-iteration no longer leaves the loop stuck. `session_compact` now schedules a fresh resume even when no `agent_end` fired for the interrupted turn (so no `pendingResumeMessage` was waiting to be rescheduled). Same fix covers split-turn auto-compactions.
- Compaction during agent setup (before the first `log_experiment`) now resumes. The post-turn gate still requires an experiment this turn to avoid resuming on plain chat replies, but the post-compaction gate is permissive — compaction itself is evidence the loop should continue.
- Rapid back-to-back compactions all resume. Dropped the 5-minute auto-resume cooldown that was sized for a different threat model (chat-only `agent_end` loops); the experiment-this-turn gate plus `MAX_AUTORESUME_TURNS = 20` already cover the looping cases the cooldown was guarding against.

### Removed

- Removed the next-iteration token-cost prediction and its `isContextExhausted` guard — pi's auto-compaction handles overflow, so autoresearch no longer needs to estimate or stop early.
- Removed the `iterationTokens` field from `ExperimentResult` and `autoresearch.jsonl`. Existing log files remain readable; the field is simply ignored. The `token-budget.sh` hook example, which relied on it, has been dropped.
- Removed the never-shipped `autoCompactResume` config option (it was opt-in for an earlier draft of this change).

## [1.1.1] - 2026-04-28

### Added

- Published to the npm registry. Install with `pi install npm:pi-autoresearch`.
- Releases now publish automatically from GitHub Actions via npm trusted publisher (OIDC) with provenance attestation.

## [1.1.0] - 2026-04-24

### Added

- Added optional `autoresearch.hooks/before.sh` and `autoresearch.hooks/after.sh` lifecycle hooks for prospective and retrospective iteration automation.
- Added the `autoresearch-hooks` skill plus example hook scripts for research fetching, learnings capture, notifications, anti-thrash, and idea rotation.

## [1.0.1] - 2026-04-22

### Fixed

- Updated the default dashboard shortcuts to `Ctrl+Shift+T` (toggle) and `Ctrl+Shift+F` (fullscreen).
- Avoided the shortcut conflict with Pi's built-in `Ctrl+X` binding introduced in newer Pi releases.

## [1.0.0] - 2026-04-20

### Added

- Initial stable release of `pi-autoresearch`.
