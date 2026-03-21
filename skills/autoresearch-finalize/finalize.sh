#!/usr/bin/env bash
set -euo pipefail

# autoresearch-finalize — creates independent branches from an autoresearch session
#
# Usage: finalize.sh <groups.json>
#
# groups.json format:
# {
#   "base": "<full merge-base commit hash>",
#   "trunk": "main",
#   "final_tree": "<full HEAD hash of autoresearch branch>",
#   "goal": "short-slug",
#   "groups": [
#     {
#       "title": "Switch to forks pool",
#       "body": "Use forks instead of threads...\n\nExperiments: #3, #5\nMetric: 42.3s → 38.1s (-9.9%)",
#       "last_commit": "<full commit hash>",
#       "slug": "forks-pool"
#     }
#   ]
# }

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

DATA_DIR=""
warn() { echo -e "${YELLOW}⚠ $1${NC}"; }
info() { echo -e "${GREEN}$1${NC}"; }
cleanup_data() { if [ -d "${DATA_DIR:-}" ]; then rm -rf "$DATA_DIR"; fi; }
fail() { cleanup_data; echo -e "${RED}ERROR: $1${NC}" >&2; exit 1; }

# Session artifacts to exclude — matched by basename
is_session_file() { local base; base=$(basename "$1"); case "$base" in autoresearch.*) return 0;; *) return 1;; esac; }

# ---------------------------------------------------------------------------
# Args
# ---------------------------------------------------------------------------

if [ $# -lt 1 ]; then
  echo "Usage: $0 <groups.json>"
  exit 1
fi

GROUPS_FILE="$1"
[ -f "$GROUPS_FILE" ] || fail "$GROUPS_FILE not found"

# ---------------------------------------------------------------------------
# Parse groups.json (single node call)
# ---------------------------------------------------------------------------

DATA_DIR=$(mktemp -d)
node -e "
const fs = require('fs');
const g = JSON.parse(fs.readFileSync('$GROUPS_FILE', 'utf-8'));
fs.writeFileSync('$DATA_DIR/base', g.base);
fs.writeFileSync('$DATA_DIR/trunk', g.trunk || 'main');
fs.writeFileSync('$DATA_DIR/final_tree', g.final_tree);
fs.writeFileSync('$DATA_DIR/goal', g.goal);
fs.writeFileSync('$DATA_DIR/count', String(g.groups.length));
g.groups.forEach((x, i) => {
  fs.writeFileSync('$DATA_DIR/' + i + '.title', x.title);
  fs.writeFileSync('$DATA_DIR/' + i + '.body', x.body);
  fs.writeFileSync('$DATA_DIR/' + i + '.last_commit', x.last_commit);
  fs.writeFileSync('$DATA_DIR/' + i + '.slug', x.slug);
});
" || fail "Failed to parse $GROUPS_FILE — check JSON syntax."

BASE=$(cat "$DATA_DIR/base")
TRUNK=$(cat "$DATA_DIR/trunk")
FINAL_TREE=$(cat "$DATA_DIR/final_tree")
GOAL=$(cat "$DATA_DIR/goal")
GROUP_COUNT=$(cat "$DATA_DIR/count")

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------

echo ""
info "═══ Preflight ═══"
echo ""

ORIG_BRANCH=$(git branch --show-current 2>/dev/null || echo "")
[ -n "$ORIG_BRANCH" ] || fail "Detached HEAD — switch to the autoresearch branch first."
[ "$ORIG_BRANCH" != "$TRUNK" ] || fail "On trunk ($TRUNK) — switch to the autoresearch branch first."

git rev-parse "$BASE" >/dev/null 2>&1 || fail "Base commit $BASE not found."
git rev-parse "$FINAL_TREE" >/dev/null 2>&1 || fail "Final tree commit $FINAL_TREE not found."

# Validate commits, collect file lists, check for overlaps and branch collisions
PREV_COMMIT="$BASE"
ALL_FILES_SEEN=""
declare -a GROUP_BRANCH
for i in $(seq 0 $((GROUP_COUNT - 1))); do
  LC=$(cat "$DATA_DIR/$i.last_commit")
  SLUG=$(cat "$DATA_DIR/$i.slug")
  git rev-parse "$LC" >/dev/null 2>&1 || fail "Group $((i+1)) last_commit $LC not found. Use full hashes (git rev-parse <short>)."

  # Get files changed in this group (incremental diff, excluding session files)
  if ! ALL_GROUP_FILES=$(git diff --name-only "$PREV_COMMIT" "$LC" 2>&1); then
    fail "git diff failed for group $((i+1)): $ALL_GROUP_FILES"
  fi
  FILES=""
  for f in $ALL_GROUP_FILES; do
    is_session_file "$f" || FILES=$(printf '%s\n%s' "$FILES" "$f")
  done
  FILES=$(echo "$FILES" | sed '/^$/d')
  echo "$FILES" > "$DATA_DIR/$i.files"

  # Check for overlapping files between groups
  for f in $FILES; do
    if echo "$ALL_FILES_SEEN" | grep -qxF "$f"; then
      fail "File '$f' appears in multiple groups. Merge the overlapping groups and retry."
    fi
  done
  if [ -z "$ALL_FILES_SEEN" ]; then
    ALL_FILES_SEEN="$FILES"
  else
    ALL_FILES_SEEN=$(printf '%s\n%s' "$ALL_FILES_SEEN" "$FILES")
  fi

  # Check for branch name collision
  NN=$(printf "%02d" $((i + 1)))
  BRANCH_NAME="autoresearch/${GOAL}/${NN}-${SLUG}"
  GROUP_BRANCH[$i]=""
  if git rev-parse --verify "$BRANCH_NAME" >/dev/null 2>&1; then
    fail "Branch '$BRANCH_NAME' already exists. Delete it first or use a different goal slug."
  fi

  PREV_COMMIT="$LC"
done

# Check verify branch collision too
VERIFY_BRANCH="autoresearch/${GOAL}/verify-tmp"
if git rev-parse --verify "$VERIFY_BRANCH" >/dev/null 2>&1; then
  fail "Branch '$VERIFY_BRANCH' already exists. Delete it first."
fi

info "Preflight passed."
echo "  Branch:     $ORIG_BRANCH"
echo "  Base:       ${BASE:0:12}"
echo "  Groups:     $GROUP_COUNT"

# ---------------------------------------------------------------------------
# Create branches
# ---------------------------------------------------------------------------

echo ""
info "═══ Creating branches ═══"
echo ""

STASHED=false
CREATED_BRANCHES=()

cleanup_on_failure() {
  local exit_code=$?
  if [ $exit_code -eq 0 ]; then return; fi

  echo ""
  echo -e "${RED}FAILED — rolling back...${NC}"
  git reset --quiet HEAD -- . 2>/dev/null || true
  for b in "${CREATED_BRANCHES[@]}"; do
    git branch -D "$b" 2>/dev/null || true
  done
  if [ -n "${ORIG_BRANCH:-}" ]; then
    git checkout "$ORIG_BRANCH" --quiet 2>/dev/null || true
  fi
  if [ "$STASHED" = true ]; then
    git stash pop --quiet 2>/dev/null || true
  fi
  cleanup_data
  echo -e "${RED}Rolled back to '$ORIG_BRANCH'. No branches left behind.${NC}"
}
trap cleanup_on_failure EXIT

if ! git diff --quiet 2>/dev/null || ! git diff --cached --quiet 2>/dev/null || [ -n "$(git ls-files --others --exclude-standard 2>/dev/null)" ]; then
  warn "Stashing uncommitted changes..."
  git stash -u
  STASHED=true
fi

for i in $(seq 0 $((GROUP_COUNT - 1))); do
  TITLE=$(cat "$DATA_DIR/$i.title")
  BODY=$(cat "$DATA_DIR/$i.body")
  LAST_COMMIT=$(cat "$DATA_DIR/$i.last_commit")
  SLUG=$(cat "$DATA_DIR/$i.slug")
  FILES=$(cat "$DATA_DIR/$i.files")

  NN=$(printf "%02d" $((i + 1)))
  BRANCH_NAME="autoresearch/${GOAL}/${NN}-${SLUG}"

  info "[$NN/$GROUP_COUNT] $TITLE"

  if [ -z "$FILES" ]; then
    warn "No files changed — skipping this group"
    GROUP_BRANCH[$i]="skipped"
    continue
  fi

  # Each branch starts from merge-base independently
  git checkout "$BASE" --quiet --detach 2>/dev/null || git checkout "$BASE" --quiet
  git checkout -b "$BRANCH_NAME"

  # Pull each file's final state from the last kept commit in this group
  for f in $FILES; do
    git checkout "$LAST_COMMIT" -- "$f"
  done
  git commit -m "$TITLE" -m "$BODY"

  CREATED_BRANCHES+=("$BRANCH_NAME")
  GROUP_BRANCH[$i]="$BRANCH_NAME"
  echo "  Branch: $BRANCH_NAME"
  echo "  Files: $FILES"
  echo ""
done

info "Created ${#CREATED_BRANCHES[@]} branches (all from merge-base, independent):"
for b in "${CREATED_BRANCHES[@]}"; do echo "  $b"; done

# Disarm rollback trap — creation succeeded
trap - EXIT

# ---------------------------------------------------------------------------
# Verify
# ---------------------------------------------------------------------------

echo ""
info "═══ Verifying ═══"
echo ""

VERIFY_ERRORS=0

# 1. Union of all branch trees should match the autoresearch branch (excluding session files)
git checkout "$BASE" --quiet --detach 2>/dev/null || git checkout "$BASE" --quiet
git checkout -b "$VERIFY_BRANCH"
for i in $(seq 0 $((GROUP_COUNT - 1))); do
  FILES=$(cat "$DATA_DIR/$i.files")
  LAST_COMMIT=$(cat "$DATA_DIR/$i.last_commit")
  for f in $FILES; do
    git checkout "$LAST_COMMIT" -- "$f"
  done
done
git commit --allow-empty -m "verify: union of all groups" --quiet

# Compare union against original, filtering out session files
TREE_DIFF_RAW=$(git diff HEAD "$FINAL_TREE" 2>/dev/null || echo "DIFF_FAILED")
if [ "$TREE_DIFF_RAW" = "DIFF_FAILED" ]; then
  echo -e "${RED}✗ Could not diff union against original tree.${NC}"
  VERIFY_ERRORS=$((VERIFY_ERRORS + 1))
else
  # Check if any non-session files differ
  NON_SESSION_DIFF=""
  for f in $(git diff --name-only HEAD "$FINAL_TREE" 2>/dev/null); do
    is_session_file "$f" || NON_SESSION_DIFF="$NON_SESSION_DIFF $f"
  done
  if [ -n "$NON_SESSION_DIFF" ]; then
    echo -e "${RED}✗ Union of groups differs from autoresearch branch!${NC}"
    echo "  Files:$NON_SESSION_DIFF"
    VERIFY_ERRORS=$((VERIFY_ERRORS + 1))
  else
    echo -e "${GREEN}✓ Union of all groups matches original autoresearch branch.${NC}"
  fi
fi

# Clean up verify branch
git checkout "$ORIG_BRANCH" --quiet 2>/dev/null || true
git branch -D "$VERIFY_BRANCH" 2>/dev/null || true

# 2. Session artifact leak per branch
ARTIFACT_CLEAN=true
for b in "${CREATED_BRANCHES[@]}"; do
  # List all files in the branch's commit diff and check for session files
  for f in $(git diff-tree --no-commit-id --name-only -r "$(git rev-parse "$b")" 2>/dev/null); do
    if is_session_file "$f"; then
      echo -e "${RED}✗ Session artifact '$f' in branch $b!${NC}"
      VERIFY_ERRORS=$((VERIFY_ERRORS + 1))
      ARTIFACT_CLEAN=false
    fi
  done
done
if [ "$ARTIFACT_CLEAN" = true ]; then
  echo -e "${GREEN}✓ No session artifacts in any branch.${NC}"
fi

# 3. Empty commits
for b in "${CREATED_BRANCHES[@]}"; do
  COMMIT=$(git rev-parse "$b" 2>/dev/null)
  DIFF=$(git diff-tree --no-commit-id --name-only -r "$COMMIT" 2>/dev/null || echo "")
  if [ -z "$DIFF" ]; then
    echo -e "${RED}✗ Empty commit in $b${NC}"
    VERIFY_ERRORS=$((VERIFY_ERRORS + 1))
  fi
done

# 4. Metric data in commit messages (warning only)
for b in "${CREATED_BRANCHES[@]}"; do
  MSG=$(git log -1 --format="%B" "$b" 2>/dev/null || echo "")
  if ! echo "$MSG" | grep -qiE '(metric|→|->|%\))'; then
    SHORT=$(git log -1 --oneline "$b" 2>/dev/null | head -c 80)
    warn "Commit $SHORT — no metric data in message"
  fi
done

echo ""
if [ $VERIFY_ERRORS -gt 0 ]; then
  echo -e "${RED}Verification failed with $VERIFY_ERRORS error(s).${NC}"
  echo -e "${RED}Branches are intact — inspect and fix manually, or delete and retry.${NC}"
  echo "  Branches: ${CREATED_BRANCHES[*]}"
  echo "  You are on: $(git branch --show-current 2>/dev/null || echo 'detached')"
  cleanup_data
  exit 1
fi
info "✓ All checks passed."

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

echo ""
info "═══ Summary ═══"
echo ""

echo "Goal: $GOAL"
echo "Base: ${BASE:0:12}"
echo "Source branch: $ORIG_BRANCH"
echo ""

echo "Branches:"
for i in $(seq 0 $((GROUP_COUNT - 1))); do
  TITLE=$(cat "$DATA_DIR/$i.title")
  BODY=$(cat "$DATA_DIR/$i.body")
  BRANCH="${GROUP_BRANCH[$i]:-skipped}"
  FILES=$(cat "$DATA_DIR/$i.files")
  NN=$(printf "%02d" $((i + 1)))
  echo ""
  echo "  $NN. $TITLE"
  echo "     Branch: $BRANCH"
  echo "     Files: $(echo $FILES | tr '\n' ' ')"
  echo ""
  echo "$BODY" | sed 's/^/     /'
done

echo ""
echo "Cleanup — after merging, delete the autoresearch branch and session files:"
echo ""
echo "  git branch -D $ORIG_BRANCH"
echo "  rm -f autoresearch.jsonl autoresearch.sh autoresearch.md autoresearch.ideas.md"

if [ -f "autoresearch.ideas.md" ]; then
  echo ""
  echo "Ideas backlog (from autoresearch.ideas.md):"
  echo ""
  sed 's/^/  /' autoresearch.ideas.md
fi

echo ""
if [ "$STASHED" = true ]; then
  warn "Changes were stashed. Run 'git stash pop' to restore or 'git stash drop' to discard."
fi

cleanup_data
