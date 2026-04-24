# Changelog

All notable changes to this project will be documented in this file.

## [1.1.0] - 2026-04-24

### Added

- Added optional `autoresearch.hooks/before.sh` and `autoresearch.hooks/after.sh` lifecycle hooks for prospective and retrospective iteration automation.
- Added the `autoresearch-hooks` skill plus example hook scripts for research fetching, learnings capture, notifications, anti-thrash, and idea rotation.

### Fixed

- Fixed autoresearch session reconstruction so hook observability entries are ignored when rebuilding run history.
- Prevented hook observability from creating or polluting `autoresearch.jsonl` before a config header exists.

## [1.0.1] - 2026-04-22

### Fixed

- Updated the default dashboard shortcuts to `Ctrl+Shift+T` (toggle) and `Ctrl+Shift+F` (fullscreen).
- Avoided the shortcut conflict with Pi's built-in `Ctrl+X` binding introduced in newer Pi releases.

## [1.0.0] - 2026-04-20

### Added

- Initial stable release of `pi-autoresearch`.
