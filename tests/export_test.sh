#!/usr/bin/env bash
set -euo pipefail

# Tests for autoresearch-export

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EXPORT_SCRIPT="${SCRIPT_DIR}/../skills/autoresearch-export/export.sh"
PASS=0
FAIL=0

setup_tmpdir() {
  TMPDIR=$(mktemp -d)
  cd "$TMPDIR"
  git init --quiet
  git remote add origin https://github.com/test/repo.git 2>/dev/null || true
  git checkout -b autoresearch/test-session --quiet 2>/dev/null || true
}

teardown_tmpdir() {
  cd /
  rm -rf "$TMPDIR"
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
    echo "    actual: $haystack"
    FAIL=$((FAIL + 1))
  fi
}

assert_exit() {
  local label="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    echo -e "  ${GREEN}✓${NC} $label"
    PASS=$((PASS + 1))
  else
    echo -e "  ${RED}✗${NC} $label (exit $actual, expected $expected)"
    FAIL=$((FAIL + 1))
  fi
}

write_jsonl() {
  cat > autoresearch.jsonl << 'EOF'
{"type":"config","name":"Test Session","metric_name":"total_ms","metric_unit":"ms","direction":"lower"}
{"commit":"aaa1111","metric":100,"metrics":{},"status":"keep","description":"baseline","timestamp":1711000000000,"segment":0,"confidence":null}
{"commit":"bbb2222","metric":120,"metrics":{},"status":"discard","description":"made it worse","timestamp":1711000001000,"segment":0,"confidence":null}
{"commit":"ccc3333","metric":80,"metrics":{},"status":"keep","description":"improved parsing","timestamp":1711000002000,"segment":0,"confidence":2.1}
{"commit":"ddd4444","metric":0,"metrics":{},"status":"crash","description":"broke everything","timestamp":1711000003000,"segment":0,"confidence":null}
EOF
  echo "# Test" > autoresearch.md
}

write_higher_jsonl() {
  cat > autoresearch.jsonl << 'EOF'
{"type":"config","name":"Test Session","metric_name":"score","metric_unit":"pts","direction":"higher"}
{"commit":"aaa1111","metric":50,"metrics":{},"status":"keep","description":"baseline","timestamp":1711000000000,"segment":0,"confidence":null}
{"commit":"bbb2222","metric":75,"metrics":{},"status":"keep","description":"improved","timestamp":1711000001000,"segment":0,"confidence":2.0}
EOF
  echo "# Test" > autoresearch.md
}

# ---------------------------------------------------------------------------
# Test: no args exits with error and lists available exporters
# ---------------------------------------------------------------------------

echo "Test: no args exits with error"
setup_tmpdir
write_jsonl
git add -A && git commit -m "init" --quiet
exit_code=0
output=$(bash "$EXPORT_SCRIPT" 2>&1) || exit_code=$?
assert_exit "exits non-zero without args" "1" "$exit_code"
assert_contains "shows usage hint" "specify which exporters" "$output"
assert_contains "lists available exporters" "sqlite" "$output"
teardown_tmpdir

# ---------------------------------------------------------------------------
# Test: --list shows available exporters
# ---------------------------------------------------------------------------

echo "Test: --list shows available exporters"
setup_tmpdir
output=$(bash "$EXPORT_SCRIPT" --list 2>&1)
assert_contains "lists sqlite" "sqlite" "$output"
teardown_tmpdir

# ---------------------------------------------------------------------------
# Test: missing jsonl exits non-zero
# ---------------------------------------------------------------------------

echo "Test: missing jsonl"
setup_tmpdir
exit_code=0
bash "$EXPORT_SCRIPT" sqlite 2>/dev/null || exit_code=$?
assert_exit "exits non-zero without jsonl" "1" "$exit_code"
teardown_tmpdir

# ---------------------------------------------------------------------------
# Test: runs named exporter
# ---------------------------------------------------------------------------

echo "Test: runs named exporter"
setup_tmpdir
write_jsonl
git add -A && git commit -m "init" --quiet
output=$(bash "$EXPORT_SCRIPT" sqlite 2>&1)
assert_contains "runs sqlite exporter" "sqlite" "$output"
assert_contains "reports 1 exporter" "1 exporter" "$output"
teardown_tmpdir

# ---------------------------------------------------------------------------
# Test: unknown exporter name reports error
# ---------------------------------------------------------------------------

echo "Test: unknown exporter name"
setup_tmpdir
write_jsonl
git add -A && git commit -m "init" --quiet
output=$(bash "$EXPORT_SCRIPT" nonexistent 2>&1)
assert_contains "reports not found" "not found" "$output"
teardown_tmpdir

# ---------------------------------------------------------------------------
# Test: project-local exporters take priority
# ---------------------------------------------------------------------------

echo "Test: project-local overrides bundled"
setup_tmpdir
write_jsonl
mkdir -p autoresearch-exporters/sqlite
cat > autoresearch-exporters/sqlite/exporter.json << 'EOF'
{"name": "sqlite", "run": "export.sh"}
EOF
cat > autoresearch-exporters/sqlite/export.sh << 'EOF'
#!/bin/bash
echo "LOCAL_OVERRIDE"
EOF
chmod +x autoresearch-exporters/sqlite/export.sh
git add -A && git commit -m "init" --quiet
output=$(bash "$EXPORT_SCRIPT" sqlite 2>&1)
assert_contains "uses local exporter" "LOCAL_OVERRIDE" "$output"
teardown_tmpdir

# ---------------------------------------------------------------------------
# Test: exporter failure doesn't block others
# ---------------------------------------------------------------------------

echo "Test: exporter failure isolation"
setup_tmpdir
write_jsonl
mkdir -p autoresearch-exporters/failing
cat > autoresearch-exporters/failing/exporter.json << 'EOF'
{"name": "failing", "run": "export.sh"}
EOF
cat > autoresearch-exporters/failing/export.sh << 'EOF'
#!/bin/bash
echo "BOOM" >&2
exit 1
EOF
chmod +x autoresearch-exporters/failing/export.sh

mkdir -p autoresearch-exporters/working
cat > autoresearch-exporters/working/exporter.json << 'EOF'
{"name": "working", "run": "export.sh"}
EOF
cat > autoresearch-exporters/working/export.sh << 'EOF'
#!/bin/bash
echo "WORKED"
EOF
chmod +x autoresearch-exporters/working/export.sh

git add -A && git commit -m "init" --quiet
output=$(bash "$EXPORT_SCRIPT" failing working 2>&1)
assert_contains "working exporter still runs" "WORKED" "$output"
assert_contains "reports failure" "exit 1" "$output"
teardown_tmpdir

# ---------------------------------------------------------------------------
# Test: direction=higher improvement_pct
# ---------------------------------------------------------------------------

echo "Test: direction=higher improvement_pct"
setup_tmpdir
write_higher_jsonl
git add -A && git commit -m "init" --quiet

mkdir -p autoresearch-exporters/dump
cat > autoresearch-exporters/dump/exporter.json << 'EOF'
{"name": "dump", "run": "export.sh"}
EOF
cat > autoresearch-exporters/dump/export.sh << 'EOF'
#!/bin/bash
node -e 'const d=JSON.parse(require("fs").readFileSync("/dev/stdin","utf-8")); console.log("PCT=" + d.session.improvement_pct)'
EOF
chmod +x autoresearch-exporters/dump/export.sh

output=$(bash "$EXPORT_SCRIPT" dump 2>&1)
assert_contains "improvement is 50%" "PCT=50" "$output"
teardown_tmpdir

# ---------------------------------------------------------------------------
# Test: EXPORTER_DIR env var passed to exporters
# ---------------------------------------------------------------------------

echo "Test: EXPORTER_DIR env var passed"
setup_tmpdir
write_jsonl
mkdir -p autoresearch-exporters/env-check
cat > autoresearch-exporters/env-check/exporter.json << 'EOF'
{"name": "env-check", "run": "export.sh"}
EOF
cat > autoresearch-exporters/env-check/export.sh << 'EOF'
#!/bin/bash
echo "DIR=${EXPORTER_DIR}"
EOF
chmod +x autoresearch-exporters/env-check/export.sh

git add -A && git commit -m "init" --quiet
output=$(bash "$EXPORT_SCRIPT" env-check 2>&1)
assert_contains "EXPORTER_DIR is set" "DIR=" "$output"
teardown_tmpdir

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "  ${GREEN}$PASS passed${NC}, ${RED}$FAIL failed${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

[ $FAIL -eq 0 ] || exit 1
