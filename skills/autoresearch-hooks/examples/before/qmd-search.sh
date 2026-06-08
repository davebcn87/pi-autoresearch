#!/usr/bin/env bash
# Same shape as external-search but targets a local qmd collection:
# a BM25 / vector / rerank index over your project's markdown.
# Useful for private or project-specific corpora (design docs, ADRs,
# runbooks, past postmortems).
#
# One-time setup: qmd collection add <path> --name <name>
# See https://www.npmjs.com/package/qmd

set -euo pipefail

readonly DOCS_FILE=".auto/docs.md"
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

fetch_docs() {
  # `qmd query` = combined search with query expansion + reranking.
  # Alternatives: `qmd search` (pure BM25), `qmd vsearch` (vector similarity).
  qmd query "$1" -n "$RESULT_LIMIT"
}

input="$(cat)"
query=$(query_from_agent_notes "$input")
[ -z "$query" ] && exit 0

workdir="$(jq -r '.cwd' <<<"$input")"
mkdir -p "$(dirname "$workdir/$DOCS_FILE")"
fetch_docs "$query" > "$workdir/$DOCS_FILE"
echo "Docs saved → $DOCS_FILE (query: $query)"
