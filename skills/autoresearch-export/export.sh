#!/usr/bin/env bash
set -euo pipefail

# autoresearch-export — discover and run exporter scripts
#
# Usage:
#   export.sh <exporter-name> [exporter-name...]
#   export.sh --list
#   export.sh --help
#
# Reads autoresearch.jsonl + autoresearch.md, builds a session JSON payload,
# and pipes it to the named exporters.
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
LIST_MODE=false
NAMES=()

# ---------------------------------------------------------------------------
# Help
# ---------------------------------------------------------------------------

usage() {
  cat <<EOF
Usage: $(basename "$0") <exporter-name> [exporter-name...]
       $(basename "$0") --list

Options:
  --list             List all discovered exporters and exit
  --help             Show this help message

Arguments:
  exporter-name      One or more exporters to run (required)

Search path (first match by name wins):
  1. ./autoresearch-exporters/
  2. ~/.pi/agent/autoresearch-exporters/
  3. <skill>/exporters/
EOF
  exit 0
}

# ---------------------------------------------------------------------------
# Args
# ---------------------------------------------------------------------------

while [[ $# -gt 0 ]]; do
  case "$1" in
    --help|-h) usage ;;
    --list) LIST_MODE=true; shift ;;
    -*) echo -e "${RED}ERROR: unknown option '$1'${NC}" >&2; exit 1 ;;
    *) NAMES+=("$1"); shift ;;
  esac
done

# ---------------------------------------------------------------------------
# Build session payload
# ---------------------------------------------------------------------------

build_payload() {
  local jsonl_file="autoresearch.jsonl"
  local md_file="autoresearch.md"

  [ -f "$jsonl_file" ] || { echo -e "${RED}ERROR: $jsonl_file not found${NC}" >&2; return 1; }

  local branch repo md_content
  branch=$(git branch --show-current 2>/dev/null || echo "unknown")
  repo=$(git remote get-url origin 2>/dev/null | sed 's|.*github.com[:/]||; s|\.git$||' || echo "unknown")
  md_content=""
  [ -f "$md_file" ] && md_content=$(cat "$md_file")

  JSONL_FILE="$jsonl_file" MD_FILE="$md_file" BRANCH="$branch" REPO="$repo" MD_CONTENT="$md_content" node -e '
const fs = require("fs");
const lines = fs.readFileSync(process.env.JSONL_FILE, "utf-8").trim().split("\n").map(l => {
  try { return JSON.parse(l); } catch { return null; }
}).filter(Boolean);

const config = lines.find(l => l.type === "config") || {};
const results = lines.filter(l => l.type !== "config");
const keeps = results.filter(r => r.status === "keep");
const baseline = results.length > 0 ? results[0].metric : 0;
const direction = config.direction || "lower";

let best = baseline;
for (const r of keeps) {
  if (direction === "lower" && r.metric < best) best = r.metric;
  if (direction === "higher" && r.metric > best) best = r.metric;
}

const delta = direction === "lower" ? baseline - best : best - baseline;
const improvement_pct = baseline !== 0 ? parseFloat((delta / baseline * 100).toFixed(1)) : 0;

// curated_wins — read from file if it exists
let curated_wins = [];
const winsFile = "autoresearch-wins.json";
try {
  if (require("fs").existsSync(winsFile)) {
    curated_wins = JSON.parse(require("fs").readFileSync(winsFile, "utf-8"));
  }
} catch {}

const payload = {
  session: {
    name: config.name || "",
    metric_name: config.metric_name || "",
    metric_unit: config.metric_unit || "",
    direction,
    baseline,
    best,
    improvement_pct,
    total_runs: results.length,
    kept: keeps.length,
    discarded: results.filter(r => r.status === "discard").length,
    crashed: results.filter(r => r.status === "crash").length,
  },
  results,
  keeps,
  curated_wins,
  context: {
    branch: process.env.BRANCH,
    repo: process.env.REPO,
    autoresearch_md: process.env.MD_CONTENT,
  },
};

process.stdout.write(JSON.stringify(payload, null, 2));
'
}

# ---------------------------------------------------------------------------
# Discover exporters
# ---------------------------------------------------------------------------

EXPORTER_DIRS=()
EXPORTER_NAMES=()
EXPORTER_DESCS=()
EXPORTER_SCRIPTS=()

name_already_seen() {
  local name="$1"
  for existing in "${EXPORTER_NAMES[@]+"${EXPORTER_NAMES[@]}"}"; do
    [ "$existing" = "$name" ] && return 0
  done
  return 1
}

discover_dir() {
  local dir="$1"
  [ -d "$dir" ] || return 0

  for exporter_dir in "$dir"/*/; do
    [ -d "$exporter_dir" ] || continue
    local manifest="${exporter_dir}exporter.json"
    [ -f "$manifest" ] || continue

    local parsed name desc run_script
    parsed=$(MANIFEST="$manifest" node -e '
      const m = JSON.parse(require("fs").readFileSync(process.env.MANIFEST, "utf-8"));
      process.stdout.write([m.name || "", m.description || "", m.run || ""].join("\n"));
    ' 2>/dev/null) || continue

    name=$(echo "$parsed" | sed -n '1p')
    desc=$(echo "$parsed" | sed -n '2p')
    run_script=$(echo "$parsed" | sed -n '3p')

    [ -n "$name" ] && [ -n "$run_script" ] || continue

    if name_already_seen "$name"; then
      continue
    fi

    EXPORTER_DIRS+=("$exporter_dir")
    EXPORTER_NAMES+=("$name")
    EXPORTER_DESCS+=("$desc")
    EXPORTER_SCRIPTS+=("$run_script")
  done
}

discover_exporters() {
  discover_dir "./autoresearch-exporters"
  discover_dir "${HOME}/.pi/agent/autoresearch-exporters"
  discover_dir "${SCRIPT_DIR}/exporters"
}

# ---------------------------------------------------------------------------
# List mode
# ---------------------------------------------------------------------------

list_exporters() {
  if [ ${#EXPORTER_NAMES[@]} -eq 0 ]; then
    echo -e "${YELLOW}No exporters found.${NC}"
    exit 0
  fi

  for i in "${!EXPORTER_NAMES[@]}"; do
    echo "  ${EXPORTER_NAMES[$i]} — ${EXPORTER_DESCS[$i]}"
  done
}

# ---------------------------------------------------------------------------
# Run exporters
# ---------------------------------------------------------------------------

run_exporters() {
  local payload="$1"
  shift
  local names=("$@")
  local ran=0
  local succeeded=0
  local failed=0

  for name in "${names[@]}"; do
    # Find the exporter by name
    local found=false
    for i in "${!EXPORTER_NAMES[@]}"; do
      if [ "${EXPORTER_NAMES[$i]}" = "$name" ]; then
        found=true
        local script="${EXPORTER_SCRIPTS[$i]}"
        local dir="${EXPORTER_DIRS[$i]}"
        local clean_dir="${dir%/}"

        ran=$((ran + 1))
        echo -n "  Running $name... "

        local exit_code=0
        local output
        output=$(echo "$payload" | EXPORTER_DIR="$clean_dir" bash "${clean_dir}/${script}" 2>&1) || exit_code=$?

        if [ $exit_code -eq 0 ]; then
          echo -e "${GREEN}✓${NC} ${output}"
          succeeded=$((succeeded + 1))
        else
          echo -e "${RED}✗${NC} (exit $exit_code): ${output}"
          failed=$((failed + 1))
        fi
        break
      fi
    done

    if [ "$found" = false ]; then
      echo -e "  ${RED}✗${NC} $name — not found"
      failed=$((failed + 1))
      ran=$((ran + 1))
    fi
  done

  echo ""
  echo "Exported via $ran exporter(s): $succeeded succeeded, $failed failed."
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

main() {
  echo ""
  echo -e "${GREEN}═══ Autoresearch Export ═══${NC}"
  echo ""

  discover_exporters

  if [ "$LIST_MODE" = true ]; then
    list_exporters
    exit 0
  fi

  if [ ${#NAMES[@]} -eq 0 ]; then
    echo -e "${RED}ERROR: specify which exporters to run${NC}" >&2
    echo "" >&2
    if [ ${#EXPORTER_NAMES[@]} -gt 0 ]; then
      echo "Available exporters:" >&2
      list_exporters >&2
    fi
    echo "" >&2
    echo "Usage: $(basename "$0") <name> [name...]" >&2
    exit 1
  fi

  echo "Found ${#EXPORTER_NAMES[@]} exporter(s): ${EXPORTER_NAMES[*]}"
  echo ""

  local payload
  payload=$(build_payload) || exit 1

  run_exporters "$payload" "${NAMES[@]}"
}

main
