#!/usr/bin/env bash
set -euo pipefail

# Tests for finalize.sh
# Creates temp git repos, simulates autoresearch sessions, and verifies behavior.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FINALIZE="$SCRIPT_DIR/finalize.sh"

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

TESTS_RUN=0
TESTS_PASSED=0
TESTS_FAILED=0

pass() { TESTS_PASSED=$((TESTS_PASSED + 1)); echo -e "${GREEN}✓ $1${NC}"; }
fail_test() { TESTS_FAILED=$((TESTS_FAILED + 1)); echo -e "${RED}✗ $1${NC}"; echo "  $2"; }

# Create a fresh test repo with a simulated autoresearch session
# Returns the repo path
setup_repo() {
  local REPO
  REPO=$(mktemp -d)
  cd "$REPO"
  git init --quiet
  git checkout -b main

  # Initial commit on main
  echo "original" > file_a.txt
  echo "original" > file_b.txt
  echo "original" > file_c.txt
  git add -A && git commit -m "initial" --quiet

  # Autoresearch branch
  git checkout -b autoresearch/test-session --quiet

  # Session files (should not end up in branches)
  echo '{"type":"config","metricName":"ms","metricUnit":"ms","bestDirection":"lower"}' > autoresearch.jsonl
  echo "# Autoresearch session" > autoresearch.md
  echo "#!/bin/bash" > autoresearch.sh
  echo "- try X" > autoresearch.ideas.md
  git add -A && git commit -m "add session files" --quiet

  # Kept experiment 1: modify file_a
  echo "optimized_a" > file_a.txt
  git add -A && git commit -m "optimize file_a" --quiet
  COMMIT_1=$(git rev-parse HEAD)

  # Kept experiment 2: modify file_b
  echo "optimized_b" > file_b.txt
  git add -A && git commit -m "optimize file_b" --quiet
  COMMIT_2=$(git rev-parse HEAD)

  # Export for tests
  echo "$REPO"
}

cleanup_repo() {
  rm -rf "$1"
}

# ---------------------------------------------------------------------------
# Test: basic two-group finalization
# ---------------------------------------------------------------------------

test_basic_two_groups() {
  TESTS_RUN=$((TESTS_RUN + 1))
  local REPO
  REPO=$(setup_repo)
  cd "$REPO"

  local BASE FINAL COMMIT_A COMMIT_B
  BASE=$(git merge-base HEAD main)
  FINAL=$(git rev-parse HEAD)
  # Get the commits for file_a and file_b changes
  COMMIT_A=$(git log --oneline --all --diff-filter=M -- file_a.txt | head -1 | awk '{print $1}')
  COMMIT_A=$(git rev-parse "$COMMIT_A")
  COMMIT_B=$(git rev-parse HEAD)

  cat > $REPO/groups.json << EOF
{
  "base": "$BASE",
  "trunk": "main",
  "final_tree": "$FINAL",
  "goal": "test",
  "groups": [
    {
      "title": "Optimize file A",
      "body": "Changed file_a.\n\nMetric: 10ms → 5ms (-50%)",
      "last_commit": "$COMMIT_A",
      "slug": "optimize-a"
    },
    {
      "title": "Optimize file B",
      "body": "Changed file_b.\n\nMetric: 5ms → 3ms (-40%)",
      "last_commit": "$COMMIT_B",
      "slug": "optimize-b"
    }
  ]
}
EOF

  local OUTPUT
  OUTPUT=$(bash "$FINALIZE" $REPO/groups.json 2>&1) || { fail_test "basic two groups" "Script failed: $OUTPUT"; cleanup_repo "$REPO"; return; }

  # Check branches exist
  git rev-parse "autoresearch/test/01-optimize-a" >/dev/null 2>&1 || { fail_test "basic two groups" "Branch 01 not created"; cleanup_repo "$REPO"; return; }
  git rev-parse "autoresearch/test/02-optimize-b" >/dev/null 2>&1 || { fail_test "basic two groups" "Branch 02 not created"; cleanup_repo "$REPO"; return; }

  # Check each branch starts from BASE
  local BASE_OF_A BASE_OF_B
  BASE_OF_A=$(git merge-base "autoresearch/test/01-optimize-a" main)
  BASE_OF_B=$(git merge-base "autoresearch/test/02-optimize-b" main)
  [ "$BASE_OF_A" = "$BASE" ] || { fail_test "basic two groups" "Branch A not from merge-base"; cleanup_repo "$REPO"; return; }
  [ "$BASE_OF_B" = "$BASE" ] || { fail_test "basic two groups" "Branch B not from merge-base"; cleanup_repo "$REPO"; return; }

  # Check branches are independent (each has exactly 1 commit from base)
  local COUNT_A COUNT_B
  COUNT_A=$(git rev-list --count "$BASE"..autoresearch/test/01-optimize-a)
  COUNT_B=$(git rev-list --count "$BASE"..autoresearch/test/02-optimize-b)
  [ "$COUNT_A" = "1" ] || { fail_test "basic two groups" "Branch A has $COUNT_A commits, expected 1"; cleanup_repo "$REPO"; return; }
  [ "$COUNT_B" = "1" ] || { fail_test "basic two groups" "Branch B has $COUNT_B commits, expected 1"; cleanup_repo "$REPO"; return; }

  # Check file contents
  local A_CONTENT B_CONTENT
  A_CONTENT=$(git show autoresearch/test/01-optimize-a:file_a.txt)
  B_CONTENT=$(git show autoresearch/test/02-optimize-b:file_b.txt)
  [ "$A_CONTENT" = "optimized_a" ] || { fail_test "basic two groups" "file_a.txt wrong in branch A: $A_CONTENT"; cleanup_repo "$REPO"; return; }
  [ "$B_CONTENT" = "optimized_b" ] || { fail_test "basic two groups" "file_b.txt wrong in branch B: $B_CONTENT"; cleanup_repo "$REPO"; return; }

  # Check branch A doesn't have file_b changes and vice versa
  local A_FILEB B_FILEA
  A_FILEB=$(git show autoresearch/test/01-optimize-a:file_b.txt)
  B_FILEA=$(git show autoresearch/test/02-optimize-b:file_a.txt)
  [ "$A_FILEB" = "original" ] || { fail_test "basic two groups" "Branch A has file_b changes"; cleanup_repo "$REPO"; return; }
  [ "$B_FILEA" = "original" ] || { fail_test "basic two groups" "Branch B has file_a changes"; cleanup_repo "$REPO"; return; }

  pass "basic two groups"
  cleanup_repo "$REPO"
}

# ---------------------------------------------------------------------------
# Test: session artifacts excluded
# ---------------------------------------------------------------------------

test_no_session_artifacts() {
  TESTS_RUN=$((TESTS_RUN + 1))
  local REPO
  REPO=$(setup_repo)
  cd "$REPO"

  local BASE FINAL
  BASE=$(git merge-base HEAD main)
  FINAL=$(git rev-parse HEAD)

  cat > $REPO/groups.json << EOF
{
  "base": "$BASE",
  "trunk": "main",
  "final_tree": "$FINAL",
  "goal": "test",
  "groups": [
    {
      "title": "All optimizations",
      "body": "Metric: 10ms → 3ms (-70%)",
      "last_commit": "$FINAL",
      "slug": "all"
    }
  ]
}
EOF

  bash "$FINALIZE" $REPO/groups.json >/dev/null 2>&1 || { fail_test "no session artifacts" "Script failed"; cleanup_repo "$REPO"; return; }

  for f in autoresearch.jsonl autoresearch.sh autoresearch.md autoresearch.ideas.md; do
    if git show "autoresearch/test/01-all":"$f" &>/dev/null 2>&1; then
      fail_test "no session artifacts" "Session file $f found in branch"
      cleanup_repo "$REPO"
      return
    fi
  done

  pass "no session artifacts"
  cleanup_repo "$REPO"
}

# ---------------------------------------------------------------------------
# Test: overlapping files rejected
# ---------------------------------------------------------------------------

test_overlapping_files_rejected() {
  TESTS_RUN=$((TESTS_RUN + 1))
  local REPO
  REPO=$(setup_repo)
  cd "$REPO"

  # Add another commit that also modifies file_a
  echo "more_optimized_a" > file_a.txt
  git add -A && git commit -m "further optimize file_a" --quiet

  local BASE FINAL
  BASE=$(git merge-base HEAD main)
  FINAL=$(git rev-parse HEAD)

  # Find the two commits that touch file_a
  local COMMITS
  COMMITS=$(git log --format="%H" --diff-filter=M -- file_a.txt)
  local COMMIT_FIRST COMMIT_SECOND
  COMMIT_SECOND=$(echo "$COMMITS" | head -1)
  COMMIT_FIRST=$(echo "$COMMITS" | tail -1)

  cat > $REPO/groups.json << EOF
{
  "base": "$BASE",
  "trunk": "main",
  "final_tree": "$FINAL",
  "goal": "test",
  "groups": [
    {
      "title": "First file_a change",
      "body": "Metric: 10ms → 5ms (-50%)",
      "last_commit": "$COMMIT_FIRST",
      "slug": "first-a"
    },
    {
      "title": "Second file_a change",
      "body": "Metric: 5ms → 3ms (-40%)",
      "last_commit": "$COMMIT_SECOND",
      "slug": "second-a"
    }
  ]
}
EOF

  local OUTPUT
  if OUTPUT=$(bash "$FINALIZE" $REPO/groups.json 2>&1); then
    fail_test "overlapping files rejected" "Script should have failed but succeeded"
    cleanup_repo "$REPO"
    return
  fi

  if echo "$OUTPUT" | grep -q "appears in multiple groups"; then
    pass "overlapping files rejected"
  else
    fail_test "overlapping files rejected" "Wrong error message: $OUTPUT"
  fi
  cleanup_repo "$REPO"
}

# ---------------------------------------------------------------------------
# Test: rollback on failure
# ---------------------------------------------------------------------------

test_rollback_on_failure() {
  TESTS_RUN=$((TESTS_RUN + 1))
  local REPO
  REPO=$(setup_repo)
  cd "$REPO"

  local BASE FINAL
  BASE=$(git merge-base HEAD main)
  FINAL=$(git rev-parse HEAD)

  # Use a bad commit hash for group 2
  local COMMIT_A
  COMMIT_A=$(git log --format="%H" --diff-filter=M -- file_a.txt | head -1)

  cat > $REPO/groups.json << EOF
{
  "base": "$BASE",
  "trunk": "main",
  "final_tree": "$FINAL",
  "goal": "test",
  "groups": [
    {
      "title": "Good group",
      "body": "Metric: 10ms → 5ms (-50%)",
      "last_commit": "$COMMIT_A",
      "slug": "good"
    },
    {
      "title": "Bad group",
      "body": "This will fail",
      "last_commit": "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      "slug": "bad"
    }
  ]
}
EOF

  bash "$FINALIZE" $REPO/groups.json >/dev/null 2>&1 && { fail_test "rollback on failure" "Script should have failed"; cleanup_repo "$REPO"; return; }

  # Should be back on original branch
  local CURRENT
  CURRENT=$(git branch --show-current 2>/dev/null || echo "")
  [ "$CURRENT" = "autoresearch/test-session" ] || { fail_test "rollback on failure" "Not on original branch: $CURRENT"; cleanup_repo "$REPO"; return; }

  # No leftover branches
  if git rev-parse "autoresearch/test/01-good" >/dev/null 2>&1; then
    fail_test "rollback on failure" "Rollback didn't delete branch 01-good"
    cleanup_repo "$REPO"
    return
  fi

  pass "rollback on failure"
  cleanup_repo "$REPO"
}

# ---------------------------------------------------------------------------
# Test: summary file generated
# ---------------------------------------------------------------------------

test_summary_output() {
  TESTS_RUN=$((TESTS_RUN + 1))
  local REPO
  REPO=$(setup_repo)
  cd "$REPO"

  local BASE FINAL
  BASE=$(git merge-base HEAD main)
  FINAL=$(git rev-parse HEAD)

  local GROUPS_JSON
  GROUPS_JSON=$(mktemp)
  cat > "$GROUPS_JSON" << EOF
{
  "base": "$BASE",
  "trunk": "main",
  "final_tree": "$FINAL",
  "goal": "test",
  "groups": [
    {
      "title": "Optimize file A",
      "body": "Metric: 10ms → 5ms (-50%)",
      "last_commit": "$FINAL",
      "slug": "optimize-a"
    }
  ]
}
EOF

  local OUTPUT
  OUTPUT=$(bash "$FINALIZE" "$GROUPS_JSON" 2>&1) || { fail_test "summary output" "Script failed"; rm -f "$GROUPS_JSON"; cleanup_repo "$REPO"; return; }

  # Check output contains key sections
  echo "$OUTPUT" | grep -q "Optimize file A" || { fail_test "summary output" "Missing group title in output"; rm -f "$GROUPS_JSON"; cleanup_repo "$REPO"; return; }
  echo "$OUTPUT" | grep -q "Cleanup" || { fail_test "summary output" "Missing cleanup in output"; rm -f "$GROUPS_JSON"; cleanup_repo "$REPO"; return; }
  echo "$OUTPUT" | grep -q "autoresearch.ideas.md" || { fail_test "summary output" "Missing ideas in output"; rm -f "$GROUPS_JSON"; cleanup_repo "$REPO"; return; }

  # No summary file should be written to disk
  [ ! -f "autoresearch-finalize-summary.md" ] || { fail_test "summary output" "Summary file written to disk — should only print"; rm -f "$GROUPS_JSON"; cleanup_repo "$REPO"; return; }

  pass "summary output"
  rm -f "$GROUPS_JSON"
  cleanup_repo "$REPO"
}

# ---------------------------------------------------------------------------
# Test: dirty tree stashed and restored on success
# ---------------------------------------------------------------------------

test_stash_on_dirty_tree() {
  TESTS_RUN=$((TESTS_RUN + 1))
  local REPO
  REPO=$(setup_repo)
  cd "$REPO"

  # Make the tree dirty
  echo "dirty" > untracked_file.txt

  local BASE FINAL
  BASE=$(git merge-base HEAD main)
  FINAL=$(git rev-parse HEAD)

  cat > $REPO/groups.json << EOF
{
  "base": "$BASE",
  "trunk": "main",
  "final_tree": "$FINAL",
  "goal": "test",
  "groups": [
    {
      "title": "All optimizations",
      "body": "Metric: 10ms → 3ms (-70%)",
      "last_commit": "$FINAL",
      "slug": "all"
    }
  ]
}
EOF

  local OUTPUT
  OUTPUT=$(bash "$FINALIZE" $REPO/groups.json 2>&1) || { fail_test "stash on dirty tree" "Script failed: $OUTPUT"; cleanup_repo "$REPO"; return; }

  # Script should mention stash
  echo "$OUTPUT" | grep -qi "stash" || { fail_test "stash on dirty tree" "No stash warning in output"; cleanup_repo "$REPO"; return; }

  pass "stash on dirty tree"
  cleanup_repo "$REPO"
}

# ---------------------------------------------------------------------------
# Test: bad groups.json path
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Test: no args shows usage
# ---------------------------------------------------------------------------

test_no_args() {
  TESTS_RUN=$((TESTS_RUN + 1))
  cd /tmp

  local OUTPUT
  if OUTPUT=$(bash "$FINALIZE" 2>&1); then
    fail_test "no args" "Script should have failed"
    return
  fi

  echo "$OUTPUT" | grep -q "Usage:" || { fail_test "no args" "No usage message: $OUTPUT"; return; }

  pass "no args"
}

# ---------------------------------------------------------------------------
# Test: detached HEAD rejected
# ---------------------------------------------------------------------------

test_detached_head() {
  TESTS_RUN=$((TESTS_RUN + 1))
  local REPO
  REPO=$(setup_repo)
  cd "$REPO"

  local BASE FINAL
  BASE=$(git merge-base HEAD main)
  FINAL=$(git rev-parse HEAD)

  cat > "$REPO/groups.json" << EOF
{
  "base": "$BASE",
  "trunk": "main",
  "final_tree": "$FINAL",
  "goal": "test",
  "groups": [
    {
      "title": "Test",
      "body": "Metric: 10 → 5 (-50%)",
      "last_commit": "$FINAL",
      "slug": "test"
    }
  ]
}
EOF

  # Detach HEAD
  git checkout --detach HEAD --quiet

  local OUTPUT
  if OUTPUT=$(bash "$FINALIZE" "$REPO/groups.json" 2>&1); then
    fail_test "detached head" "Script should have failed"
    cleanup_repo "$REPO"
    return
  fi

  echo "$OUTPUT" | grep -qi "detached" || { fail_test "detached head" "Wrong error: $OUTPUT"; cleanup_repo "$REPO"; return; }

  pass "detached head"
  cleanup_repo "$REPO"
}

# ---------------------------------------------------------------------------
# Test: on trunk rejected
# ---------------------------------------------------------------------------

test_on_trunk() {
  TESTS_RUN=$((TESTS_RUN + 1))
  local REPO
  REPO=$(setup_repo)
  cd "$REPO"

  local BASE FINAL
  BASE=$(git merge-base HEAD main)
  FINAL=$(git rev-parse HEAD)

  cat > "$REPO/groups.json" << EOF
{
  "base": "$BASE",
  "trunk": "main",
  "final_tree": "$FINAL",
  "goal": "test",
  "groups": [
    {
      "title": "Test",
      "body": "Metric: 10 → 5 (-50%)",
      "last_commit": "$FINAL",
      "slug": "test"
    }
  ]
}
EOF

  git checkout main --quiet

  local OUTPUT
  if OUTPUT=$(bash "$FINALIZE" "$REPO/groups.json" 2>&1); then
    fail_test "on trunk" "Script should have failed"
    cleanup_repo "$REPO"
    return
  fi

  echo "$OUTPUT" | grep -qi "trunk" || { fail_test "on trunk" "Wrong error: $OUTPUT"; cleanup_repo "$REPO"; return; }

  pass "on trunk"
  cleanup_repo "$REPO"
}

# ---------------------------------------------------------------------------
# Test: malformed JSON
# ---------------------------------------------------------------------------

test_malformed_json() {
  TESTS_RUN=$((TESTS_RUN + 1))
  local REPO
  REPO=$(setup_repo)
  cd "$REPO"

  echo '{ "base": "abc", BROKEN' > "$REPO/groups.json"

  local OUTPUT
  if OUTPUT=$(bash "$FINALIZE" "$REPO/groups.json" 2>&1); then
    fail_test "malformed json" "Script should have failed"
    cleanup_repo "$REPO"
    return
  fi

  echo "$OUTPUT" | grep -q "check JSON syntax" || { fail_test "malformed json" "Wrong error: $OUTPUT"; cleanup_repo "$REPO"; return; }

  # No orphaned temp dirs (check DATA_DIR was cleaned)
  pass "malformed json"
  cleanup_repo "$REPO"
}

# ---------------------------------------------------------------------------
# Test: branch collision detected
# ---------------------------------------------------------------------------

test_branch_collision() {
  TESTS_RUN=$((TESTS_RUN + 1))
  local REPO
  REPO=$(setup_repo)
  cd "$REPO"

  local BASE FINAL
  BASE=$(git merge-base HEAD main)
  FINAL=$(git rev-parse HEAD)

  # Pre-create a branch that will collide
  git branch "autoresearch/test/01-optimize-a" "$BASE"

  COMMIT_A=$(git log --format="%H" --diff-filter=M -- file_a.txt | head -1)
  cat > "$REPO/groups.json" << EOF
{
  "base": "$BASE",
  "trunk": "main",
  "final_tree": "$FINAL",
  "goal": "test",
  "groups": [
    {
      "title": "Optimize file A",
      "body": "Metric: 10ms → 5ms (-50%)",
      "last_commit": "$COMMIT_A",
      "slug": "optimize-a"
    }
  ]
}
EOF

  local OUTPUT
  if OUTPUT=$(bash "$FINALIZE" "$REPO/groups.json" 2>&1); then
    fail_test "branch collision" "Script should have failed"
    cleanup_repo "$REPO"
    return
  fi

  echo "$OUTPUT" | grep -q "already exists" || { fail_test "branch collision" "Wrong error: $OUTPUT"; cleanup_repo "$REPO"; return; }

  pass "branch collision"
  cleanup_repo "$REPO"
}

# ---------------------------------------------------------------------------
# Test: bad groups.json path
# ---------------------------------------------------------------------------

test_missing_groups_json() {
  TESTS_RUN=$((TESTS_RUN + 1))

  cd /tmp
  local OUTPUT
  if OUTPUT=$(bash "$FINALIZE" /tmp/nonexistent-groups.json 2>&1); then
    fail_test "missing groups.json" "Script should have failed"
    return
  fi

  echo "$OUTPUT" | grep -q "not found" || { fail_test "missing groups.json" "Wrong error: $OUTPUT"; return; }

  pass "missing groups.json"
}

# ---------------------------------------------------------------------------
# Test: single group works
# ---------------------------------------------------------------------------

test_single_group() {
  TESTS_RUN=$((TESTS_RUN + 1))
  local REPO
  REPO=$(setup_repo)
  cd "$REPO"

  local BASE FINAL
  BASE=$(git merge-base HEAD main)
  FINAL=$(git rev-parse HEAD)

  cat > $REPO/groups.json << EOF
{
  "base": "$BASE",
  "trunk": "main",
  "final_tree": "$FINAL",
  "goal": "test",
  "groups": [
    {
      "title": "All optimizations",
      "body": "Everything in one.\n\nMetric: 10ms → 3ms (-70%)",
      "last_commit": "$FINAL",
      "slug": "all"
    }
  ]
}
EOF

  bash "$FINALIZE" $REPO/groups.json >/dev/null 2>&1 || { fail_test "single group" "Script failed"; cleanup_repo "$REPO"; return; }

  git rev-parse "autoresearch/test/01-all" >/dev/null 2>&1 || { fail_test "single group" "Branch not created"; cleanup_repo "$REPO"; return; }

  # Should have both file changes
  local A B
  A=$(git show autoresearch/test/01-all:file_a.txt)
  B=$(git show autoresearch/test/01-all:file_b.txt)
  [ "$A" = "optimized_a" ] || { fail_test "single group" "file_a wrong: $A"; cleanup_repo "$REPO"; return; }
  [ "$B" = "optimized_b" ] || { fail_test "single group" "file_b wrong: $B"; cleanup_repo "$REPO"; return; }

  pass "single group"
  cleanup_repo "$REPO"
}

# ---------------------------------------------------------------------------
# Test: session artifacts in subdirectories excluded
# ---------------------------------------------------------------------------

test_nested_session_artifacts() {
  TESTS_RUN=$((TESTS_RUN + 1))
  local REPO
  REPO=$(mktemp -d)
  cd "$REPO"
  git init --quiet
  git checkout -b main

  mkdir -p libs/polaris
  echo "original" > libs/polaris/component.ts
  git add -A && git commit -m "initial" --quiet

  git checkout -b autoresearch/nested-test --quiet

  # Session files in a subdirectory (like world's libraries/javascript/polaris/)
  echo '{"type":"config"}' > libs/polaris/autoresearch.jsonl
  echo "# session" > libs/polaris/autoresearch.md
  echo "#!/bin/bash" > libs/polaris/autoresearch.sh
  echo "- idea" > libs/polaris/autoresearch.ideas.md
  echo "#!/bin/bash" > libs/polaris/autoresearch.checks.sh
  echo "optimized" > libs/polaris/component.ts
  git add -A && git commit -m "optimize + session files" --quiet

  local BASE FINAL
  BASE=$(git merge-base HEAD main)
  FINAL=$(git rev-parse HEAD)

  cat > "$REPO/groups.json" << EOF
{
  "base": "$BASE",
  "trunk": "main",
  "final_tree": "$FINAL",
  "goal": "test",
  "groups": [
    {
      "title": "Optimize component",
      "body": "Metric: 10ms → 5ms (-50%)",
      "last_commit": "$FINAL",
      "slug": "optimize"
    }
  ]
}
EOF

  local OUTPUT
  OUTPUT=$(bash "$FINALIZE" "$REPO/groups.json" 2>&1) || { fail_test "nested session artifacts" "Script failed: $OUTPUT"; cleanup_repo "$REPO"; return; }

  # Branch should only have component.ts, not any autoresearch.* files
  local BRANCH="autoresearch/test/01-optimize"
  for f in $(git diff-tree --no-commit-id --name-only -r "$(git rev-parse "$BRANCH")"); do
    local base
    base=$(basename "$f")
    case "$base" in
      autoresearch.*)
        fail_test "nested session artifacts" "Session artifact '$f' leaked into branch"
        cleanup_repo "$REPO"
        return
        ;;
    esac
  done

  # Verify the actual code file is there
  local CONTENT
  CONTENT=$(git show "$BRANCH":libs/polaris/component.ts)
  [ "$CONTENT" = "optimized" ] || { fail_test "nested session artifacts" "component.ts wrong: $CONTENT"; cleanup_repo "$REPO"; return; }

  pass "nested session artifacts"
  cleanup_repo "$REPO"
}

# ---------------------------------------------------------------------------
# Test: verification failure leaves branches intact and returns to orig branch
# ---------------------------------------------------------------------------

test_verify_failure_leaves_branches() {
  TESTS_RUN=$((TESTS_RUN + 1))
  local REPO
  REPO=$(setup_repo)
  cd "$REPO"

  local BASE FINAL
  BASE=$(git merge-base HEAD main)
  FINAL=$(git rev-parse HEAD)

  # Only group file_a — final_tree has both a+b, so verify will fail
  COMMIT_A=$(git log --format="%H" --diff-filter=M -- file_a.txt | head -1)

  cat > "$REPO/groups.json" << EOF
{
  "base": "$BASE",
  "trunk": "main",
  "final_tree": "$FINAL",
  "goal": "test",
  "groups": [
    {
      "title": "Optimize file A only",
      "body": "Metric: 10ms → 5ms (-50%)",
      "last_commit": "$COMMIT_A",
      "slug": "optimize-a"
    }
  ]
}
EOF

  local OUTPUT
  if bash "$FINALIZE" "$REPO/groups.json" >/dev/null 2>&1; then
    fail_test "verify failure leaves branches" "Script should have failed (verify mismatch)"
    cleanup_repo "$REPO"
    return
  fi

  # Branch should still exist
  git rev-parse "autoresearch/test/01-optimize-a" >/dev/null 2>&1 || { fail_test "verify failure leaves branches" "Branch was deleted"; cleanup_repo "$REPO"; return; }

  # Should be back on original branch
  local CURRENT
  CURRENT=$(git branch --show-current 2>/dev/null || echo "")
  [ "$CURRENT" = "autoresearch/test-session" ] || { fail_test "verify failure leaves branches" "Not on original branch: $CURRENT"; cleanup_repo "$REPO"; return; }

  pass "verify failure leaves branches"
  cleanup_repo "$REPO"
}

# ---------------------------------------------------------------------------
# Test: dirty tree + mid-creation failure pops stash
# ---------------------------------------------------------------------------

test_stash_pop_on_rollback() {
  TESTS_RUN=$((TESTS_RUN + 1))
  local REPO
  REPO=$(setup_repo)
  cd "$REPO"

  # Make the tree dirty with a tracked file change
  echo "dirty_tracked" > file_c.txt

  local BASE FINAL
  BASE=$(git merge-base HEAD main)
  FINAL=$(git rev-parse HEAD)

  COMMIT_A=$(git log --format="%H" --diff-filter=M -- file_a.txt | head -1)

  cat > "$REPO/groups.json" << EOF
{
  "base": "$BASE",
  "trunk": "main",
  "final_tree": "$FINAL",
  "goal": "test",
  "groups": [
    {
      "title": "Good group",
      "body": "Metric: 10ms → 5ms (-50%)",
      "last_commit": "$COMMIT_A",
      "slug": "good"
    },
    {
      "title": "Bad group",
      "body": "This will fail",
      "last_commit": "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      "slug": "bad"
    }
  ]
}
EOF

  bash "$FINALIZE" "$REPO/groups.json" >/dev/null 2>&1 && { fail_test "stash pop on rollback" "Script should have failed"; cleanup_repo "$REPO"; return; }

  # Should be back on original branch
  local CURRENT
  CURRENT=$(git branch --show-current 2>/dev/null || echo "")
  [ "$CURRENT" = "autoresearch/test-session" ] || { fail_test "stash pop on rollback" "Not on original branch: $CURRENT"; cleanup_repo "$REPO"; return; }

  # Dirty change should be restored
  local C_CONTENT
  C_CONTENT=$(cat file_c.txt)
  [ "$C_CONTENT" = "dirty_tracked" ] || { fail_test "stash pop on rollback" "Stash not popped — file_c.txt is '$C_CONTENT'"; cleanup_repo "$REPO"; return; }

  pass "stash pop on rollback"
  cleanup_repo "$REPO"
}

# ---------------------------------------------------------------------------
# Test: skipped group with empty diff
# ---------------------------------------------------------------------------

test_skipped_empty_group() {
  TESTS_RUN=$((TESTS_RUN + 1))
  local REPO
  REPO=$(setup_repo)
  cd "$REPO"

  local BASE FINAL
  BASE=$(git merge-base HEAD main)
  FINAL=$(git rev-parse HEAD)

  # Group 1: points to a commit where file_a changed
  COMMIT_A=$(git log --format="%H" --diff-filter=M -- file_a.txt | head -1)

  # Group 2: same last_commit as group 1 — diff between them is empty
  # Group 3: covers file_b changes
  cat > "$REPO/groups.json" << EOF
{
  "base": "$BASE",
  "trunk": "main",
  "final_tree": "$FINAL",
  "goal": "test",
  "groups": [
    {
      "title": "Optimize file A",
      "body": "Metric: 10ms → 5ms (-50%)",
      "last_commit": "$COMMIT_A",
      "slug": "optimize-a"
    },
    {
      "title": "Empty group",
      "body": "Nothing here",
      "last_commit": "$COMMIT_A",
      "slug": "empty"
    },
    {
      "title": "Optimize file B",
      "body": "Metric: 5ms → 3ms (-40%)",
      "last_commit": "$FINAL",
      "slug": "optimize-b"
    }
  ]
}
EOF

  local OUTPUT
  OUTPUT=$(bash "$FINALIZE" "$REPO/groups.json" 2>&1) || { fail_test "skipped empty group" "Script failed: $OUTPUT"; cleanup_repo "$REPO"; return; }

  # Should have created 2 branches, not 3
  local COUNT
  COUNT=$(echo "$OUTPUT" | grep -c "Created .* branches")
  [ "$COUNT" = "1" ] || { fail_test "skipped empty group" "No creation summary found"; cleanup_repo "$REPO"; return; }
  echo "$OUTPUT" | grep -q "Created 2 branches" || { fail_test "skipped empty group" "Expected 2 branches created"; cleanup_repo "$REPO"; return; }

  # Should mention skipping
  echo "$OUTPUT" | grep -q "skipping" || { fail_test "skipped empty group" "No skip warning"; cleanup_repo "$REPO"; return; }

  pass "skipped empty group"
  cleanup_repo "$REPO"
}

# ---------------------------------------------------------------------------
# Test: three groups (off-by-one in PREV_COMMIT chaining)
# ---------------------------------------------------------------------------

test_three_groups() {
  TESTS_RUN=$((TESTS_RUN + 1))
  local REPO
  REPO=$(mktemp -d)
  cd "$REPO"
  git init --quiet
  git checkout -b main

  echo "original_a" > file_a.txt
  echo "original_b" > file_b.txt
  echo "original_c" > file_c.txt
  git add -A && git commit -m "initial" --quiet

  git checkout -b autoresearch/three-test --quiet

  # Three sequential optimizations, each touching a different file
  echo "optimized_a" > file_a.txt
  git add -A && git commit -m "optimize a" --quiet
  COMMIT_A=$(git rev-parse HEAD)

  echo "optimized_b" > file_b.txt
  git add -A && git commit -m "optimize b" --quiet
  COMMIT_B=$(git rev-parse HEAD)

  echo "optimized_c" > file_c.txt
  git add -A && git commit -m "optimize c" --quiet
  COMMIT_C=$(git rev-parse HEAD)

  local BASE FINAL
  BASE=$(git merge-base HEAD main)
  FINAL=$(git rev-parse HEAD)

  cat > "$REPO/groups.json" << EOF
{
  "base": "$BASE",
  "trunk": "main",
  "final_tree": "$FINAL",
  "goal": "three",
  "groups": [
    {
      "title": "Optimize A",
      "body": "Metric: 10 → 8 (-20%)",
      "last_commit": "$COMMIT_A",
      "slug": "a"
    },
    {
      "title": "Optimize B",
      "body": "Metric: 8 → 6 (-25%)",
      "last_commit": "$COMMIT_B",
      "slug": "b"
    },
    {
      "title": "Optimize C",
      "body": "Metric: 6 → 4 (-33%)",
      "last_commit": "$COMMIT_C",
      "slug": "c"
    }
  ]
}
EOF

  local OUTPUT
  OUTPUT=$(bash "$FINALIZE" "$REPO/groups.json" 2>&1) || { fail_test "three groups" "Script failed: $OUTPUT"; cleanup_repo "$REPO"; return; }

  # All 3 branches exist
  git rev-parse "autoresearch/three/01-a" >/dev/null 2>&1 || { fail_test "three groups" "Branch 01 missing"; cleanup_repo "$REPO"; return; }
  git rev-parse "autoresearch/three/02-b" >/dev/null 2>&1 || { fail_test "three groups" "Branch 02 missing"; cleanup_repo "$REPO"; return; }
  git rev-parse "autoresearch/three/03-c" >/dev/null 2>&1 || { fail_test "three groups" "Branch 03 missing"; cleanup_repo "$REPO"; return; }

  # Each branch is independent — 1 commit from base
  for b in autoresearch/three/01-a autoresearch/three/02-b autoresearch/three/03-c; do
    local C
    C=$(git rev-list --count "$BASE".."$b")
    [ "$C" = "1" ] || { fail_test "three groups" "$b has $C commits, expected 1"; cleanup_repo "$REPO"; return; }
  done

  # Each branch only has its own file changed
  [ "$(git show autoresearch/three/01-a:file_a.txt)" = "optimized_a" ] || { fail_test "three groups" "01-a: wrong file_a"; cleanup_repo "$REPO"; return; }
  [ "$(git show autoresearch/three/01-a:file_b.txt)" = "original_b" ] || { fail_test "three groups" "01-a: has file_b changes"; cleanup_repo "$REPO"; return; }
  [ "$(git show autoresearch/three/02-b:file_b.txt)" = "optimized_b" ] || { fail_test "three groups" "02-b: wrong file_b"; cleanup_repo "$REPO"; return; }
  [ "$(git show autoresearch/three/02-b:file_a.txt)" = "original_a" ] || { fail_test "three groups" "02-b: has file_a changes"; cleanup_repo "$REPO"; return; }
  [ "$(git show autoresearch/three/03-c:file_c.txt)" = "optimized_c" ] || { fail_test "three groups" "03-c: wrong file_c"; cleanup_repo "$REPO"; return; }

  # Verify passed (output should contain the checkmark)
  echo "$OUTPUT" | grep -q "Union of all groups matches" || { fail_test "three groups" "Verify didn't pass"; cleanup_repo "$REPO"; return; }

  pass "three groups"
  cleanup_repo "$REPO"
}

# ---------------------------------------------------------------------------
# Run all tests
# ---------------------------------------------------------------------------

echo ""
echo "Running finalize.sh tests..."
echo ""

test_no_args
test_malformed_json
test_branch_collision
test_missing_groups_json
test_detached_head
test_on_trunk
test_basic_two_groups
test_nested_session_artifacts
test_verify_failure_leaves_branches
test_stash_pop_on_rollback
test_skipped_empty_group
test_three_groups
test_no_session_artifacts
test_overlapping_files_rejected
test_rollback_on_failure
test_summary_output
test_stash_on_dirty_tree
test_single_group

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "Tests: $TESTS_RUN  Passed: ${GREEN}$TESTS_PASSED${NC}  Failed: ${RED}$TESTS_FAILED${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

[ $TESTS_FAILED -eq 0 ] || exit 1
