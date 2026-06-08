#!/usr/bin/env bash
# When the rules file exceeds a size threshold, keep the preamble and
# archive the tail. Prevents session-document bloat from eating context.

set -euo pipefail

readonly MAX_BYTES=$((20 * 1024))
readonly KEEP_LINES=80

file_too_large() {
  [ "$(wc -c < "$1")" -gt "$MAX_BYTES" ]
}

archive_tail() {
  local file="$1" archive="${1%.md}.archive.md"
  tail -n +$((KEEP_LINES + 1)) "$file" >> "$archive"
  head -n "$KEEP_LINES" "$file" > "$file.tmp"
  mv "$file.tmp" "$file"
}

resolve_prompt() {
  [ -f "$1/.auto/prompt.md" ] && { echo "$1/.auto/prompt.md"; return; }
  echo "$1/autoresearch.md"
}

input="$(cat)"
md="$(resolve_prompt "$(jq -r '.cwd' <<<"$input")")"
[ -f "$md" ] && file_too_large "$md" || exit 0

archive_tail "$md"
echo "Rotated $md (kept first $KEEP_LINES lines, archived rest)."
