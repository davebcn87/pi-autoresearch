#!/usr/bin/env bash
# Infers a query from the agent's natural notes and fetches external material.
# Swap the search-cli call for any tool you have: an MCP client, a CLI over
# a documentation index, a curl to a search API, a web-search wrapper.

set -euo pipefail

readonly RESEARCH_FILE=".auto/research.md"
readonly RESULT_LIMIT=5

query_from_agent_notes() {
  jq -r '
    .last_run.asi.next_focus //
    .last_run.asi.hypothesis //
    .last_run.description //
    .session.goal //
    empty
  ' <<<"$1"
}

fetch_results() {
  # Replace with your search tool of choice.
  search-cli "$1" -n "$RESULT_LIMIT"
}

input="$(cat)"
query=$(query_from_agent_notes "$input")
[ -z "$query" ] && exit 0

workdir="$(jq -r '.cwd' <<<"$input")"
mkdir -p "$(dirname "$workdir/$RESEARCH_FILE")"
fetch_results "$query" > "$workdir/$RESEARCH_FILE"
echo "Research saved → $RESEARCH_FILE (query: $query)"
