#!/usr/bin/env bash
# Integration test for MiniMax provider.
# Verifies MINIMAX_API_KEY is set and that the MiniMax API is reachable
# using the Anthropic-compatible endpoint registered by pi-autoresearch.
#
# Usage:
#   MINIMAX_API_KEY=<key> bash tests/minimax_test.sh
#
# Exit codes: 0 = pass, 1 = fail, 77 = skip (no API key)
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

TESTS_RUN=0
TESTS_PASSED=0
TESTS_FAILED=0

pass() { TESTS_PASSED=$((TESTS_PASSED + 1)); TESTS_RUN=$((TESTS_RUN + 1)); echo -e "${GREEN}✓ $1${NC}"; }
skip() { echo -e "${YELLOW}⚠ $1${NC}"; }
fail_test() { TESTS_FAILED=$((TESTS_FAILED + 1)); TESTS_RUN=$((TESTS_RUN + 1)); echo -e "${RED}✗ $1${NC}"; echo "  $2"; }

echo "=== MiniMax provider tests ==="
echo ""

# --- Unit test: verify provider configuration constants ---

echo "--- Unit tests ---"

# Verify expected models are defined in the extension source
EXT_FILE="$(cd "$(dirname "$0")/.." && pwd)/extensions/pi-autoresearch/index.ts"

if grep -q '"MiniMax-M2.7"' "$EXT_FILE" && grep -q '"MiniMax-M2.7-highspeed"' "$EXT_FILE"; then
  pass "Extension registers MiniMax-M2.7 and MiniMax-M2.7-highspeed models"
else
  fail_test "Extension does not register MiniMax models" "Expected 'MiniMax-M2.7' and 'MiniMax-M2.7-highspeed' in $EXT_FILE"
fi

if grep -q 'api.minimax.io/anthropic' "$EXT_FILE"; then
  pass "Extension uses MiniMax Anthropic-compatible endpoint"
else
  fail_test "Wrong or missing base URL" "Expected 'api.minimax.io/anthropic' in $EXT_FILE"
fi

if grep -q '"MINIMAX_API_KEY"' "$EXT_FILE"; then
  pass "Extension reads MINIMAX_API_KEY for authentication"
else
  fail_test "MINIMAX_API_KEY not referenced" "Expected '\"MINIMAX_API_KEY\"' in $EXT_FILE"
fi

if grep -q '"anthropic-messages"' "$EXT_FILE"; then
  pass "Extension configures anthropic-messages API type"
else
  fail_test "API type not set to anthropic-messages" "Expected '\"anthropic-messages\"' in $EXT_FILE"
fi

echo ""
echo "--- Integration tests ---"

if [ -z "${MINIMAX_API_KEY:-}" ]; then
  skip "MINIMAX_API_KEY not set — skipping live API call"
  echo ""
  echo "Results: $TESTS_PASSED passed, $TESTS_FAILED failed (integration skipped)"
  exit "${TESTS_FAILED}"
fi

# Integration test: call MiniMax Anthropic-compatible API
ENDPOINT="https://api.minimax.io/anthropic/v1/messages"
REQUEST_BODY='{"model":"MiniMax-M2.7","max_tokens":256,"messages":[{"role":"user","content":"Reply with the single word: pong"}]}'

HTTP_STATUS=$(curl -s -o /tmp/minimax_response.json -w "%{http_code}" \
  -X POST "$ENDPOINT" \
  -H "x-api-key: ${MINIMAX_API_KEY}" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d "$REQUEST_BODY" 2>/dev/null)

if [ "$HTTP_STATUS" = "200" ]; then
  # Extract text from any content block with type=text (model may also emit thinking blocks)
  CONTENT=$(python3 -c "
import json, sys
d = json.load(open('/tmp/minimax_response.json'))
texts = [b['text'] for b in d.get('content', []) if b.get('type') == 'text']
print(texts[0] if texts else '')
" 2>/dev/null || echo "")
  if [ -n "$CONTENT" ]; then
    pass "MiniMax-M2.7 API call succeeded (HTTP 200, response: '$CONTENT')"
  else
    fail_test "MiniMax-M2.7 API returned 200 but no text block in response" "$(cat /tmp/minimax_response.json)"
  fi
else
  fail_test "MiniMax-M2.7 API call failed" "HTTP $HTTP_STATUS: $(cat /tmp/minimax_response.json)"
fi

echo ""
echo "Results: $TESTS_PASSED/$TESTS_RUN passed, $TESTS_FAILED failed"
exit "${TESTS_FAILED}"
