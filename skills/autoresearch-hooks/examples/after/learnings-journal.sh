#!/usr/bin/env bash
# Append one human-readable line per run to a file that survives revert
# and accumulates across sessions. Pure side effect — no steer.

set -euo pipefail

readonly LEARNINGS_FILE=".auto/learnings.md"

run_number()     { jq -r '.run_entry.run' <<<"$1"; }
run_status()     { jq -r '.run_entry.status' <<<"$1"; }
run_metric()     { jq -r '.run_entry.metric' <<<"$1"; }
run_hypothesis() { jq -r '.run_entry.asi.hypothesis // "-"' <<<"$1"; }

append_journal_line() {
  local file="$1" run="$2" status="$3" metric="$4" hyp="$5"
  mkdir -p "$(dirname "$file")"
  printf 'run=%s status=%s metric=%s hyp=%s\n' "$run" "$status" "$metric" "$hyp" >> "$file"
}

input="$(cat)"
file="$(jq -r '.cwd' <<<"$input")/$LEARNINGS_FILE"

append_journal_line "$file" \
  "$(run_number "$input")" \
  "$(run_status "$input")" \
  "$(run_metric "$input")" \
  "$(run_hypothesis "$input")"
