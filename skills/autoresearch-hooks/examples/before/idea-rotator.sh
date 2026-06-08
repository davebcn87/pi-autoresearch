#!/usr/bin/env bash
# If the ideas backlog exists, surface the top unchecked bullet
# as a steer nudge. Format assumes markdown checkboxes: `- [ ] idea`.

set -euo pipefail

readonly IDEAS_FILE=".auto/ideas.md"
readonly LEGACY_IDEAS_FILE="autoresearch.ideas.md"
readonly UNCHECKED_PATTERN='^- \[ \]'

first_unchecked_idea() {
  grep -m1 -E "$UNCHECKED_PATTERN" "$1" | sed 's/^- \[ \] //'
}

resolve_ideas() {
  [ -f "$1/$IDEAS_FILE" ] && { echo "$1/$IDEAS_FILE"; return; }
  [ -f "$1/$LEGACY_IDEAS_FILE" ] && { echo "$1/$LEGACY_IDEAS_FILE"; return; }
}

input="$(cat)"
ideas="$(resolve_ideas "$(jq -r '.cwd' <<<"$input")")"
[ -n "$ideas" ] && [ -f "$ideas" ] || exit 0

next=$(first_unchecked_idea "$ideas")
[ -z "$next" ] && exit 0
echo "Next idea from $ideas: $next"
