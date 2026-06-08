#!/usr/bin/env bash
# After N consecutive discards, emit a steer suggesting a structural rethink.
# Uses session state plus the jsonl tail to detect repeated failure patterns.

set -euo pipefail

readonly WINDOW_SIZE=5
readonly STREAK_THRESHOLD=5

recent_discard_count() {
  jq -c 'select(.run != null and (.type // null) != "hook")' "$1" 2>/dev/null \
    | tail -n "$WINDOW_SIZE" \
    | jq -r 'select(.status == "discard") | .run' \
    | wc -l | tr -d ' '
}

thrash_suggestions() {
  echo "⚠️ $1 consecutive discards. Consider:"
  echo "  - Re-reading .auto/prompt.md and the benchmark script"
  echo "  - Trying something structurally different, not another variation"
  echo "  - Measuring what the CPU is actually spending time on"
}

resolve_jsonl() {
  [ -f "$1/.auto/log.jsonl" ] && { echo "$1/.auto/log.jsonl"; return; }
  echo "$1/autoresearch.jsonl"
}

input="$(cat)"
jsonl="$(resolve_jsonl "$(jq -r '.cwd' <<<"$input")")"
streak=$(recent_discard_count "$jsonl")

[ "$streak" -lt "$STREAK_THRESHOLD" ] && exit 0
thrash_suggestions "$streak"
