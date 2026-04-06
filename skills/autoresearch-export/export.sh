#!/usr/bin/env bash
set -euo pipefail

# autoresearch-export — discover and run exporter scripts
#
# Usage:
#   export.sh [--all] [exporter-name]
#
# Reads autoresearch.jsonl + autoresearch.md, builds a session JSON payload,
# discovers exporters from the search path, and pipes the payload to each.
#
# Search path (first match by name wins):
#   1. ./autoresearch-exporters/
#   2. ~/.pi/agent/autoresearch-exporters/
#   3. <script-dir>/exporters/

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TRIGGER_MODE="export"
FILTER_NAME=""

# ---------------------------------------------------------------------------
# Args
# ---------------------------------------------------------------------------

while [[ $# -gt 0 ]]; do
  case "$1" in
    --all) TRIGGER_MODE="all"; shift ;;
    --trigger) TRIGGER_MODE="$2"; shift 2 ;;
    *) FILTER_NAME="$1"; shift ;;
  esac
done

# ---------------------------------------------------------------------------
# Build session payload
# ---------------------------------------------------------------------------

build_payload() {
  local jsonl_file="autoresearch.jsonl"
  local md_file="autoresearch.md"

  [ -f "$jsonl_file" ] || { echo -e "${RED}ERROR: $jsonl_file not found${NC}" >&2; exit 1; }

  local branch repo md_content
  branch=$(git branch --show-current 2>/dev/null || echo "unknown")
  repo=$(git remote get-url origin 2>/dev/null | sed 's|.*github.com[:/]\(.*\)\.git|\1|' || echo "unknown")
  md_content=""
  [ -f "$md_file" ] && md_content=$(cat "$md_file")

  node -e "
const fs = require('fs');
const lines = fs.readFileSync('$jsonl_file', 'utf-8').trim().split('\n').map(l => {
  try { return JSON.parse(l); } catch { return null; }
}).filter(Boolean);

// Find config header (type: 'config')
const config = lines.find(l => l.type === 'config') || {};
const results = lines.filter(l => l.type !== 'config');
const keeps = results.filter(r => r.status === 'keep');
const baseline = results.length > 0 ? results[0].metric : 0;
const direction = config.direction || 'lower';

let best = baseline;
for (const r of keeps) {
  if (direction === 'lower' && r.metric < best) best = r.metric;
  if (direction === 'higher' && r.metric > best) best = r.metric;
}

const improvement_pct = baseline !== 0
  ? parseFloat((((baseline - best) / baseline) * 100 * (direction === 'lower' ? 1 : -1)).toFixed(1))
  : 0;

const payload = {
  session: {
    name: config.name || '',
    metric_name: config.metric_name || '',
    metric_unit: config.metric_unit || '',
    direction,
    baseline,
    best,
    improvement_pct: Math.abs(improvement_pct),
    total_runs: results.length,
    kept: keeps.length,
    discarded: results.filter(r => r.status === 'discard').length,
    crashed: results.filter(r => r.status === 'crash').length,
  },
  results,
  keeps,
  context: {
    branch: $(node -e "process.stdout.write(JSON.stringify('$branch'))"),
    repo: $(node -e "process.stdout.write(JSON.stringify('$repo'))"),
    autoresearch_md: $(node -e "process.stdout.write(JSON.stringify(fs.readFileSync('$md_file','utf-8')))" 2>/dev/null || echo '""'),
  },
};

process.stdout.write(JSON.stringify(payload, null, 2));
"
}

# ---------------------------------------------------------------------------
# Discover exporters
# ---------------------------------------------------------------------------

declare -A SEEN_NAMES
declare -a EXPORTER_DIRS
declare -a EXPORTER_NAMES
declare -a EXPORTER_TRIGGERS
declare -a EXPORTER_SCRIPTS

discover_dir() {
  local dir="$1"
  [ -d "$dir" ] || return 0

  for exporter_dir in "$dir"/*/; do
    [ -d "$exporter_dir" ] || continue
    local manifest="$exporter_dir/exporter.json"
    [ -f "$manifest" ] || continue

    local name trigger run_script
    name=$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('$manifest','utf-8')).name || '')")
    trigger=$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('$manifest','utf-8')).trigger || 'export')")
    run_script=$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('$manifest','utf-8')).run || '')")

    [ -n "$name" ] && [ -n "$run_script" ] || continue

    # First match wins
    if [ -n "${SEEN_NAMES[$name]:-}" ]; then
      continue
    fi
    SEEN_NAMES[$name]=1

    EXPORTER_DIRS+=("$exporter_dir")
    EXPORTER_NAMES+=("$name")
    EXPORTER_TRIGGERS+=("$trigger")
    EXPORTER_SCRIPTS+=("$run_script")
  done
}

discover_exporters() {
  discover_dir "./autoresearch-exporters"
  discover_dir "${HOME}/.pi/agent/autoresearch-exporters"
  discover_dir "${SCRIPT_DIR}/exporters"
}

# ---------------------------------------------------------------------------
# Run exporters
# ---------------------------------------------------------------------------

run_exporters() {
  local payload="$1"
  local ran=0
  local succeeded=0
  local failed=0

  for i in "${!EXPORTER_NAMES[@]}"; do
    local name="${EXPORTER_NAMES[$i]}"
    local trigger="${EXPORTER_TRIGGERS[$i]}"
    local script="${EXPORTER_SCRIPTS[$i]}"
    local dir="${EXPORTER_DIRS[$i]}"

    # Filter by name if specified
    if [ -n "$FILTER_NAME" ] && [ "$name" != "$FILTER_NAME" ]; then
      continue
    fi

    # Filter by trigger mode
    if [ "$TRIGGER_MODE" != "all" ] && [ "$trigger" != "$TRIGGER_MODE" ]; then
      # "keep" trigger also runs on "always"
      if [ "$TRIGGER_MODE" = "keep" ] && [ "$trigger" != "always" ]; then
        continue
      fi
      # "export" trigger doesn't match "always" or "keep"
      if [ "$TRIGGER_MODE" = "export" ] && [ "$trigger" != "export" ]; then
        continue
      fi
    fi

    ran=$((ran + 1))
    echo -n "  Running $name... "

    local exit_code=0
    local output
    output=$(echo "$payload" | EXPORTER_DIR="$dir" bash "${dir}${script}" 2>&1) || exit_code=$?

    if [ $exit_code -eq 0 ]; then
      echo -e "${GREEN}✓${NC} ${output}"
      succeeded=$((succeeded + 1))
    else
      echo -e "${RED}✗${NC} (exit $exit_code): ${output}"
      failed=$((failed + 1))
    fi
  done

  echo ""
  if [ $ran -eq 0 ]; then
    echo -e "${YELLOW}No exporters matched (trigger=$TRIGGER_MODE${FILTER_NAME:+, name=$FILTER_NAME}).${NC}"
  else
    echo "Exported via $ran exporter(s): $succeeded succeeded, $failed failed."
  fi
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

main() {
  echo ""
  echo -e "${GREEN}═══ Autoresearch Export ═══${NC}"
  echo ""

  discover_exporters

  if [ ${#EXPORTER_NAMES[@]} -eq 0 ]; then
    echo -e "${YELLOW}No exporters found. Add exporters to:${NC}"
    echo "  ./autoresearch-exporters/"
    echo "  ~/.pi/agent/autoresearch-exporters/"
    exit 0
  fi

  echo "Found ${#EXPORTER_NAMES[@]} exporter(s): ${EXPORTER_NAMES[*]}"
  echo ""

  local payload
  payload=$(build_payload)

  run_exporters "$payload"
}

main
