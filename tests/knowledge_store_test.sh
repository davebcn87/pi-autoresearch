#!/usr/bin/env bash
set -euo pipefail

# Tests for SQLite exporter + seed.sh

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SQLITE_EXPORTER="${SCRIPT_DIR}/../skills/autoresearch-export/exporters/sqlite/export.sh"
SEED_SCRIPT="${SCRIPT_DIR}/../skills/autoresearch-seed/seed.sh"
PASS=0
FAIL=0

setup_tmpdir() {
  TMPDIR=$(mktemp -d)
  export AUTORESEARCH_DB="${TMPDIR}/test.db"
  cd "$TMPDIR"
  git init --quiet
  git remote add origin https://github.com/test/my-project.git 2>/dev/null || true
}

teardown_tmpdir() {
  cd /
  rm -rf "$TMPDIR"
  unset AUTORESEARCH_DB
}

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    echo -e "  ${GREEN}✓${NC} $label"
    PASS=$((PASS + 1))
  else
    echo -e "  ${RED}✗${NC} $label"
    echo "    expected: $expected"
    echo "    actual:   $actual"
    FAIL=$((FAIL + 1))
  fi
}

assert_contains() {
  local label="$1" needle="$2" haystack="$3"
  if echo "$haystack" | grep -q "$needle"; then
    echo -e "  ${GREEN}✓${NC} $label"
    PASS=$((PASS + 1))
  else
    echo -e "  ${RED}✗${NC} $label"
    echo "    expected to contain: $needle"
    FAIL=$((FAIL + 1))
  fi
}

assert_not_contains() {
  local label="$1" needle="$2" haystack="$3"
  if echo "$haystack" | grep -q "$needle"; then
    echo -e "  ${RED}✗${NC} $label"
    echo "    should not contain: $needle"
    FAIL=$((FAIL + 1))
  else
    echo -e "  ${GREEN}✓${NC} $label"
    PASS=$((PASS + 1))
  fi
}

make_export_payload() {
  local session_name="${1:-Test Session}"
  local curated_wins="${2:-[]}"
  cat << EOJSON
{
  "session": {
    "name": "$session_name",
    "metric_name": "total_ms",
    "metric_unit": "ms",
    "direction": "lower",
    "baseline": 100,
    "best": 70,
    "improvement_pct": 30,
    "total_runs": 10,
    "kept": 3,
    "discarded": 6,
    "crashed": 1
  },
  "results": [],
  "keeps": [],
  "curated_wins": $curated_wins,
  "context": {
    "branch": "autoresearch/test-session",
    "repo": "test/my-project",
    "autoresearch_md": "# Autoresearch: $session_name"
  }
}
EOJSON
}

LIQUID_WINS='[
  {
    "technique": "Replace regex tokenizer with hand-rolled state machine",
    "description": "The regex engine was the bottleneck. A hand-rolled state machine avoids backtracking and runs in a single pass.",
    "metric_before": 100,
    "metric_after": 68,
    "commits": ["aaa1111", "bbb2222"],
    "files": ["lib/liquid/tokenizer.rb"],
    "dead_ends": ["Tried memoizing regex matches — no improvement"]
  },
  {
    "technique": "Cache parsed AST between renders",
    "description": "Templates are parsed on every render. Caching the AST avoids redundant parsing for repeated renders.",
    "metric_before": 68,
    "metric_after": 55,
    "commits": ["ccc3333"],
    "files": ["lib/liquid/ast_cache.rb"],
    "dead_ends": []
  }
]'

# ---------------------------------------------------------------------------
# Test: SQLite exporter creates DB, sessions table, and wins
# ---------------------------------------------------------------------------

echo "Test: SQLite exporter writes session and wins"
setup_tmpdir

output=$(make_export_payload "Optimize liquid parsing" "$LIQUID_WINS" | bash "$SQLITE_EXPORTER" 2>&1)
assert_contains "reports success" "wrote 2 win" "$output"

session_count=$(sqlite3 "$AUTORESEARCH_DB" "SELECT COUNT(*) FROM sessions")
assert_eq "one session in DB" "1" "$session_count"

session_goal=$(sqlite3 "$AUTORESEARCH_DB" "SELECT goal FROM sessions LIMIT 1")
assert_eq "session goal stored" "Optimize liquid parsing" "$session_goal"

win_count=$(sqlite3 "$AUTORESEARCH_DB" "SELECT COUNT(*) FROM wins")
assert_eq "two wins in DB" "2" "$win_count"

# Verify wins have session_id FK
session_id=$(sqlite3 "$AUTORESEARCH_DB" "SELECT session_id FROM wins LIMIT 1")
assert_eq "win linked to session" "test/my-project:autoresearch/test-session" "$session_id"

# Verify FTS populated via trigger
fts_count=$(sqlite3 "$AUTORESEARCH_DB" "SELECT COUNT(*) FROM wins_fts")
assert_eq "FTS has two entries (via trigger)" "2" "$fts_count"

technique=$(sqlite3 "$AUTORESEARCH_DB" "SELECT technique FROM wins LIMIT 1")
assert_eq "technique stored" "Replace regex tokenizer with hand-rolled state machine" "$technique"

# Verify autoresearch_md stored once in sessions, not in wins
md_in_session=$(sqlite3 "$AUTORESEARCH_DB" "SELECT LENGTH(autoresearch_md) FROM sessions LIMIT 1")
[ "$md_in_session" -gt 0 ] && echo -e "  ${GREEN}✓${NC} autoresearch_md in sessions" && PASS=$((PASS+1)) || { echo -e "  ${RED}✗${NC} autoresearch_md not in sessions"; FAIL=$((FAIL+1)); }

teardown_tmpdir

# ---------------------------------------------------------------------------
# Test: SQLite exporter is append-only for wins
# ---------------------------------------------------------------------------

echo "Test: SQLite exporter appends wins on re-run"
setup_tmpdir

make_export_payload "Session 1" "$LIQUID_WINS" | bash "$SQLITE_EXPORTER" >/dev/null 2>&1
make_export_payload "Session 1" "$LIQUID_WINS" | bash "$SQLITE_EXPORTER" >/dev/null 2>&1

win_count=$(sqlite3 "$AUTORESEARCH_DB" "SELECT COUNT(*) FROM wins")
assert_eq "four wins after two exports (append-only)" "4" "$win_count"

# But still one session (upsert)
session_count=$(sqlite3 "$AUTORESEARCH_DB" "SELECT COUNT(*) FROM sessions")
assert_eq "still one session (upsert)" "1" "$session_count"

teardown_tmpdir

# ---------------------------------------------------------------------------
# Test: SQLite exporter handles empty curated_wins
# ---------------------------------------------------------------------------

echo "Test: SQLite exporter with no curated wins"
setup_tmpdir

output=$(make_export_payload "Empty Session" "[]" | bash "$SQLITE_EXPORTER" 2>&1)
assert_contains "reports no wins" "no curated wins" "$output"

teardown_tmpdir

# ---------------------------------------------------------------------------
# Test: FTS trigger keeps index in sync
# ---------------------------------------------------------------------------

echo "Test: FTS trigger keeps index in sync"
setup_tmpdir

make_export_payload "Optimize liquid parsing" "$LIQUID_WINS" | bash "$SQLITE_EXPORTER" >/dev/null 2>&1

# FTS should find by technique
fts_result=$(sqlite3 "$AUTORESEARCH_DB" "SELECT COUNT(*) FROM wins_fts WHERE wins_fts MATCH '\"tokenizer\"'")
assert_eq "FTS finds by technique" "1" "$fts_result"

# FTS should find by description
fts_result=$(sqlite3 "$AUTORESEARCH_DB" "SELECT COUNT(*) FROM wins_fts WHERE wins_fts MATCH '\"backtracking\"'")
assert_eq "FTS finds by description" "1" "$fts_result"

teardown_tmpdir

# ---------------------------------------------------------------------------
# Test: seed finds relevant wins
# ---------------------------------------------------------------------------

echo "Test: seed finds relevant wins"
setup_tmpdir

make_export_payload "Optimize liquid parsing" "$LIQUID_WINS" | bash "$SQLITE_EXPORTER" >/dev/null 2>&1

# Switch to a different branch for the seed
git checkout -b autoresearch/different-session --quiet 2>/dev/null || true
cat > autoresearch.md << 'EOF'
# Autoresearch: Optimize liquid rendering
EOF
git add -A && git commit -m "init" --quiet

output=$(bash "$SEED_SCRIPT" 2>&1)
assert_contains "finds technique" "hand-rolled state machine" "$output"
assert_contains "finds second technique" "Cache parsed AST" "$output"
assert_contains "includes dead ends" "Dead end" "$output"
assert_contains "includes files" "tokenizer.rb" "$output"

teardown_tmpdir

# ---------------------------------------------------------------------------
# Test: seed excludes current session
# ---------------------------------------------------------------------------

echo "Test: seed excludes current session"
setup_tmpdir

make_export_payload "Optimize liquid parsing" "$LIQUID_WINS" | bash "$SQLITE_EXPORTER" >/dev/null 2>&1

# Query from the same repo+branch
git checkout -b autoresearch/test-session --quiet 2>/dev/null || true
cat > autoresearch.md << 'EOF'
# Autoresearch: Optimize liquid parsing
EOF
git add -A && git commit -m "init" --quiet

output=$(bash "$SEED_SCRIPT" 2>&1)
assert_eq "no output for same session" "" "$output"

teardown_tmpdir

# ---------------------------------------------------------------------------
# Test: seed returns nothing for unrelated query
# ---------------------------------------------------------------------------

echo "Test: seed returns nothing for unrelated query"
setup_tmpdir

make_export_payload "Optimize liquid parsing" "$LIQUID_WINS" | bash "$SQLITE_EXPORTER" >/dev/null 2>&1

git checkout -b autoresearch/other --quiet 2>/dev/null || true
cat > autoresearch.md << 'EOF'
# Autoresearch: Reduce memory footprint of image thumbnailing
EOF
git add -A && git commit -m "init" --quiet

output=$(bash "$SEED_SCRIPT" 2>&1)
assert_not_contains "no results for unrelated query" "hand-rolled" "$output"

teardown_tmpdir

# ---------------------------------------------------------------------------
# Test: seed exits cleanly without DB
# ---------------------------------------------------------------------------

echo "Test: seed exits cleanly without DB"
setup_tmpdir
export AUTORESEARCH_DB="${TMPDIR}/nonexistent.db"

cat > autoresearch.md << 'EOF'
# Autoresearch: Something
EOF

output=$(bash "$SEED_SCRIPT" 2>&1)
assert_eq "no output" "" "$output"

teardown_tmpdir

# ---------------------------------------------------------------------------
# Test: seed with query override
# ---------------------------------------------------------------------------

echo "Test: seed with query override"
setup_tmpdir

make_export_payload "Optimize liquid parsing" "$LIQUID_WINS" | bash "$SQLITE_EXPORTER" >/dev/null 2>&1

git checkout -b autoresearch/other --quiet 2>/dev/null || true
git commit --allow-empty -m "init" --quiet

output=$(bash "$SEED_SCRIPT" "liquid tokenizer" 2>&1)
assert_contains "finds via query override" "hand-rolled state machine" "$output"

teardown_tmpdir

# ---------------------------------------------------------------------------
# Test: multiple sessions coexist
# ---------------------------------------------------------------------------

echo "Test: multiple sessions coexist"
setup_tmpdir

TEST_WINS='[{"technique":"Parallelize workers","description":"Split work across cores","metric_before":60,"metric_after":30,"commits":["eee5555"],"files":["config/workers.rb"],"dead_ends":[]}]'

make_export_payload "Optimize liquid parsing" "$LIQUID_WINS" | bash "$SQLITE_EXPORTER" >/dev/null 2>&1

# Different session
PAYLOAD=$(make_export_payload "Speed up test suite" "$TEST_WINS")
PAYLOAD=$(echo "$PAYLOAD" | node -e '
  const d = JSON.parse(require("fs").readFileSync("/dev/stdin","utf-8"));
  d.context.branch = "autoresearch/test-speed";
  process.stdout.write(JSON.stringify(d));
')
echo "$PAYLOAD" | bash "$SQLITE_EXPORTER" >/dev/null 2>&1

session_count=$(sqlite3 "$AUTORESEARCH_DB" "SELECT COUNT(*) FROM sessions")
assert_eq "two sessions in DB" "2" "$session_count"

win_count=$(sqlite3 "$AUTORESEARCH_DB" "SELECT COUNT(*) FROM wins")
assert_eq "three total wins" "3" "$win_count"

teardown_tmpdir

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "  ${GREEN}$PASS passed${NC}, ${RED}$FAIL failed${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

[ $FAIL -eq 0 ] || exit 1
