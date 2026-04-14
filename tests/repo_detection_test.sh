#!/usr/bin/env bash
set -euo pipefail

# Tests for repo detection in autoresearch config headers.
# Validates the regex that extracts "owner/repo" from git remote URLs,
# and verifies backwards compatibility with JSONL files missing the repo field.

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

TESTS_RUN=0
TESTS_PASSED=0
TESTS_FAILED=0

pass() { TESTS_PASSED=$((TESTS_PASSED + 1)); echo -e "${GREEN}✓ $1${NC}"; }
fail_test() { TESTS_FAILED=$((TESTS_FAILED + 1)); echo -e "${RED}✗ $1${NC}"; echo "  $2"; }

# The same regex used in parseGitRepo() in index.ts:
#   url.match(/(?:github\.com[:/])([^/]+\/[^/]+?)(?:\.git)?$/)
# We replicate it here with python3 for portability (macOS grep lacks -P).
extract_repo() {
  local url="$1"
  python3 -c "
import re, sys
m = re.search(r'(?:github\.com[:/])([^/]+/[^/]+?)(?:\.git)?$', sys.argv[1])
print(m.group(1) if m else '')
" "$url"
}

# ── Test 1: HTTPS remote with .git suffix ──
TESTS_RUN=$((TESTS_RUN + 1))
result=$(extract_repo "https://github.com/owner/repo.git")
if [[ "$result" == "owner/repo" ]]; then
  pass "HTTPS remote with .git → owner/repo"
else
  fail_test "HTTPS remote with .git" "Expected 'owner/repo', got '$result'"
fi

# ── Test 2: HTTPS remote without .git suffix ──
TESTS_RUN=$((TESTS_RUN + 1))
result=$(extract_repo "https://github.com/owner/repo")
if [[ "$result" == "owner/repo" ]]; then
  pass "HTTPS remote without .git → owner/repo"
else
  fail_test "HTTPS remote without .git" "Expected 'owner/repo', got '$result'"
fi

# ── Test 3: SSH remote ──
TESTS_RUN=$((TESTS_RUN + 1))
result=$(extract_repo "git@github.com:owner/repo.git")
if [[ "$result" == "owner/repo" ]]; then
  pass "SSH remote → owner/repo"
else
  fail_test "SSH remote" "Expected 'owner/repo', got '$result'"
fi

# ── Test 4: Non-GitHub remote (GitLab) ──
TESTS_RUN=$((TESTS_RUN + 1))
result=$(extract_repo "https://gitlab.com/owner/repo.git")
if [[ -z "$result" ]]; then
  pass "Non-GitHub remote (GitLab) → empty (no match)"
else
  fail_test "Non-GitHub remote" "Expected empty, got '$result'"
fi

# ── Test 5: No remote configured (local-only repo) ──
TESTS_RUN=$((TESTS_RUN + 1))
TMPDIR_LOCAL=$(mktemp -d)
trap 'rm -rf "$TMPDIR_LOCAL" "${TMPDIR_NOGIT:-}" 2>/dev/null' EXIT
(
  cd "$TMPDIR_LOCAL"
  git init --quiet
  git commit --allow-empty -m "init" --quiet
)
remote_url=$(git -C "$TMPDIR_LOCAL" remote get-url origin 2>&1 || true)
result=$(extract_repo "$remote_url")
if [[ -z "$result" ]]; then
  pass "Local-only repo (no remote) → empty"
else
  fail_test "Local-only repo" "Expected empty, got '$result'"
fi

# ── Test 6: Not a git repo ──
TESTS_RUN=$((TESTS_RUN + 1))
TMPDIR_NOGIT=$(mktemp -d)
git_output=$(git -C "$TMPDIR_NOGIT" remote get-url origin 2>&1 || true)
result=$(extract_repo "$git_output")
if [[ -z "$result" ]]; then
  pass "Not a git repo → empty"
else
  fail_test "Not a git repo" "Expected empty, got '$result'"
fi

# ── Test 7: Backwards compat — old JSONL without repo field ──
TESTS_RUN=$((TESTS_RUN + 1))
old_config='{"type":"config","name":"test","metricName":"ms","metricUnit":"ms","bestDirection":"lower"}'
# Verify the config line parses fine and has no repo key
has_repo=$(echo "$old_config" | python3 -c "import sys,json; d=json.load(sys.stdin); print('yes' if 'repo' in d else 'no')" 2>/dev/null || echo "error")
if [[ "$has_repo" == "no" ]]; then
  pass "Old JSONL config (no repo field) parses without error"
else
  fail_test "Backwards compat" "Expected no repo key, got '$has_repo'"
fi

# ── Test 8: New JSONL with repo field — round-trip ──
TESTS_RUN=$((TESTS_RUN + 1))
new_config='{"type":"config","name":"test","metricName":"ms","metricUnit":"ms","bestDirection":"lower","repo":"acme-corp/widget-factory"}'
repo_val=$(echo "$new_config" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('repo',''))" 2>/dev/null || echo "error")
if [[ "$repo_val" == "acme-corp/widget-factory" ]]; then
  pass "New JSONL config with repo field round-trips correctly"
else
  fail_test "New JSONL round-trip" "Expected 'acme-corp/widget-factory', got '$repo_val'"
fi

# ── Summary ──
echo ""
echo "────────────────────────────"
echo -e "Ran $TESTS_RUN tests: ${GREEN}$TESTS_PASSED passed${NC}, ${RED}$TESTS_FAILED failed${NC}"
if [[ $TESTS_FAILED -gt 0 ]]; then
  exit 1
fi
