# Changelog

All notable changes to this project will be documented in this file.

## Unreleased

### Changed

- Long-running loops now ride pi's auto-compaction instead of stopping. When pi summarizes older messages on context overflow, autoresearch detects the resulting idle and re-prompts the agent to re-read `autoresearch.md`, the tail of `autoresearch.jsonl`, `autoresearch.ideas.md`, and `git log` before continuing.

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
