#!/usr/bin/env bash
set -euo pipefail

# seed.sh — search the local knowledge store for relevant prior work
#
# Usage: seed.sh [query-override]
#
# Reads autoresearch.md to build a query, searches ~/.pi/agent/autoresearch.db,
# outputs a markdown section to stdout. Exit 0 with no output = nothing found.

DB_PATH="${AUTORESEARCH_DB:-${HOME}/.pi/agent/autoresearch.db}"

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------

if ! command -v sqlite3 &>/dev/null; then
  exit 0
fi

if [ ! -f "$DB_PATH" ]; then
  exit 0
fi

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

normalize_repo() {
  sed 's|.*github.com[:/]||; s|\.git$||'
}

# ---------------------------------------------------------------------------
# Build query context
# ---------------------------------------------------------------------------

QUERY_OVERRIDE="${1:-}"
GOAL=""
FILES="[]"

if [ -f "autoresearch.md" ]; then
  GOAL=$(head -5 autoresearch.md | sed -n 's/^#.*Autoresearch[: ]*//Ip' | head -1)

  local_files=$(awk '/^## Files in Scope/,/^## /' autoresearch.md \
    | grep -E '^\s*-' \
    | sed 's/^\s*-\s*//' \
    | sed 's/\s*—.*//' 2>/dev/null || true)

  if [ -n "$local_files" ]; then
    FILES=$(echo "$local_files" | node -e '
      const lines = require("fs").readFileSync("/dev/stdin","utf-8").trim().split("\n").filter(Boolean);
      process.stdout.write(JSON.stringify(lines));
    ' 2>/dev/null || echo "[]")
  fi
fi

[ -n "$QUERY_OVERRIDE" ] && GOAL="$QUERY_OVERRIDE"
[ -n "$GOAL" ] || exit 0

BRANCH=$(git branch --show-current 2>/dev/null || echo "unknown")
REPO=$(git remote get-url origin 2>/dev/null | normalize_repo || echo "unknown")

# ---------------------------------------------------------------------------
# Query and format
# ---------------------------------------------------------------------------

GOAL="$GOAL" REPO="$REPO" BRANCH="$BRANCH" DB_PATH="$DB_PATH" node -e '
const { execSync } = require("child_process");

const goal = process.env.GOAL;
const currentRepo = process.env.REPO;
const currentBranch = process.env.BRANCH;
const dbPath = process.env.DB_PATH;

// Build FTS5 query — strip punctuation, drop short words, join with OR
const terms = goal
  .replace(/[^\w\s]/g, " ")
  .split(/\s+/)
  .filter(t => t.length > 2)
  .map(t => `"${t}"`)
  .join(" OR ");

if (!terms) process.exit(0);

const esc = (s) => String(s).replace(/\x27/g, "\x27\x27");

const sql = `
SELECT json_group_array(json_object(
  '"'"'technique'"'"', w.technique,
  '"'"'description'"'"', w.description,
  '"'"'metric_before'"'"', w.metric_before,
  '"'"'metric_after'"'"', w.metric_after,
  '"'"'metric_name'"'"', s.metric_name,
  '"'"'metric_unit'"'"', s.metric_unit,
  '"'"'files'"'"', w.files,
  '"'"'dead_ends'"'"', w.dead_ends,
  '"'"'session_name'"'"', s.goal,
  '"'"'repo'"'"', s.repo,
  '"'"'branch'"'"', s.branch,
  '"'"'created_at'"'"', w.created_at
))
FROM wins w
JOIN sessions s ON s.id = w.session_id
WHERE w.id IN (SELECT rowid FROM wins_fts WHERE wins_fts MATCH '"'"'${esc(terms)}'"'"')
  AND NOT (s.repo = '"'"'${esc(currentRepo)}'"'"' AND s.branch = '"'"'${esc(currentBranch)}'"'"')
ORDER BY w.created_at DESC
LIMIT 15;
`;

let raw;
try {
  raw = execSync(`sqlite3 "${dbPath}" "${sql.replace(/"/g, "\\\"")}"`, {
    encoding: "utf-8",
    timeout: 5000,
  }).trim();
} catch {
  process.exit(0);
}

if (!raw) process.exit(0);

let rows;
try { rows = JSON.parse(raw); } catch { process.exit(0); }
if (!rows || rows.length === 0) process.exit(0);

// Group by session
const sessions = new Map();
for (const r of rows) {
  const key = `${r.repo}:${r.branch}`;
  if (!sessions.has(key)) {
    sessions.set(key, { session_name: r.session_name, created_at: r.created_at, wins: [] });
  }
  sessions.get(key).wins.push(r);
}

const lines = [];
for (const [, s] of sessions) {
  const date = s.created_at ? s.created_at.split(" ")[0] : "unknown";
  lines.push(`### ${s.session_name} (${date})`);
  lines.push("");

  for (const w of s.wins) {
    const metric = (w.metric_before && w.metric_after)
      ? ` — ${w.metric_name}: ${w.metric_before} → ${w.metric_after}${w.metric_unit}`
      : "";
    lines.push(`- **${w.technique}**${metric}`);
    lines.push(`  ${w.description}`);

    let files = [];
    try { files = JSON.parse(w.files); } catch {}
    if (Array.isArray(files) && files.length > 0) lines.push(`  Files: ${files.join(", ")}`);

    let dead_ends = [];
    try { dead_ends = JSON.parse(w.dead_ends); } catch {}
    if (Array.isArray(dead_ends) && dead_ends.length > 0) {
      for (const de of dead_ends) lines.push(`  ⚠ Dead end: ${de}`);
    }
  }
  lines.push("");
}

if (lines.length > 0) process.stdout.write(lines.join("\n"));
'
