#!/usr/bin/env bash
# Tests for submit-harness-issue.sh stdin JSON parsing logic.
#
# Background: issue !112 — script used `readFileSync('/dev/stdin')` which breaks
# on Windows (node resolves `/dev/stdin` to `E:\dev\stdin` → ENOENT).
# Fix: replace with cross-platform `process.stdin` stream API.
#
# These tests extract the actual inline `node -e` expressions from the script
# source (lines for SUBMITTER and IID parsing) and assert they:
#   1. Produce expected output for valid JSON
#   2. Return empty (not crash) for invalid JSON — error swallow preserved
#   3. Do NOT reference `/dev/stdin` (the Windows-incompatible pattern)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TARGET="${SCRIPT_DIR}/../submit-harness-issue.sh"

PASS=0
FAIL=0

pass() { echo "PASS"; PASS=$((PASS + 1)); }
fail() { echo "FAIL — $1"; FAIL=$((FAIL + 1)); }

if [ ! -f "${TARGET}" ]; then
    echo "SKIP: submit-harness-issue.sh not found at ${TARGET}"
    exit 1
fi

echo "submit-harness-issue.sh stdin-parse Tests"
echo "=========================================="

# ── Extract the two inline `node -e '...'` expressions from the script ──
#
# The script uses single-quoted inline node expressions. We match any
# `node -e '...'` (single quotes don't nest, so this is unambiguous), then
# classify by content: SUBMITTER references u.username, IID references .iid.

extract_all_node_exprs() {
    # Returns each expression on its own line, payload only (without `node -e '` and trailing `'`).
    { grep -oP "node -e '[^']+'" "${TARGET}" 2>/dev/null || true; } \
        | sed "s/^node -e '//; s/'$//"
}

# Grab the SUBMITTER expression (contains u.username) and IID expression (contains .iid).
ALL_EXPRS=$(extract_all_node_exprs)
SUBMITTER_NODE_EXPR=$(echo "${ALL_EXPRS}" | grep "u\.username" | head -1)
IID_NODE_EXPR=$(echo "${ALL_EXPRS}" | grep "JSON\.parse(d)\.iid" | head -1)

if [ -z "${SUBMITTER_NODE_EXPR}" ]; then
    echo "FAIL: could not extract SUBMITTER node expression from ${TARGET}" >&2
    exit 1
fi
if [ -z "${IID_NODE_EXPR}" ]; then
    echo "FAIL: could not extract IID node expression from ${TARGET}" >&2
    exit 1
fi

# Test 1: SUBMITTER parses valid user JSON → "username (name)"
echo -n "  SUBMITTER valid JSON → 'alice (Alice)': "
INPUT='{"iid": 42, "username": "alice", "name": "Alice"}'
OUT=$(echo "${INPUT}" | node -e "${SUBMITTER_NODE_EXPR}" 2>/dev/null || echo "")
[ "${OUT}" = "alice (Alice)" ] && pass || fail "expected 'alice (Alice)', got '${OUT}'"

# Test 2: IID parses valid issue JSON → iid number
echo -n "  IID valid JSON → '42': "
OUT=$(echo "${INPUT}" | node -e "${IID_NODE_EXPR}" 2>/dev/null || echo "")
[ "${OUT}" = "42" ] && pass || fail "expected '42', got '${OUT}'"

# Test 3: SUBMITTER swallows invalid JSON → empty (no crash)
echo -n "  SUBMITTER invalid JSON → empty: "
OUT=$(echo 'not-json-at-all' | node -e "${SUBMITTER_NODE_EXPR}" 2>/dev/null || echo "")
[ -z "${OUT}" ] && pass || fail "expected empty output for invalid JSON, got '${OUT}'"

# Test 4: IID swallows invalid JSON → empty (no crash)
echo -n "  IID invalid JSON → empty: "
OUT=$(echo 'not-json-at-all' | node -e "${IID_NODE_EXPR}" 2>/dev/null || echo "")
[ -z "${OUT}" ] && pass || fail "expected empty output for invalid JSON, got '${OUT}'"

# Test 5: Empty input → empty output (no crash)
echo -n "  SUBMITTER empty input → empty: "
OUT=$(printf '' | node -e "${SUBMITTER_NODE_EXPR}" 2>/dev/null || echo "")
[ -z "${OUT}" ] && pass || fail "expected empty output for empty input, got '${OUT}'"

# Test 6: Unicode in user name preserved
echo -n "  SUBMITTER unicode name preserved: "
INPUT='{"username":"bob","name":"张三"}'
OUT=$(echo "${INPUT}" | node -e "${SUBMITTER_NODE_EXPR}" 2>/dev/null || echo "")
[ "${OUT}" = "bob (张三)" ] && pass || fail "expected 'bob (张三)', got '${OUT}'"

# Test 7: REGRESSION — script must NOT use `/dev/stdin` in CODE (Windows-incompatible).
# Comments mentioning /dev/stdin are fine (explanatory); only executable lines matter.
echo -n "  no /dev/stdin in code lines (Windows compat): "
# Strip full-line comments and inline comments (everything from `#` to EOL),
# then check for the Windows-incompatible pattern.
if sed 's/#.*$//' "${TARGET}" | grep -q "/dev/stdin"; then
    fail "script still uses /dev/stdin in code — Windows will break (issue !112)"
else
    pass
fi

# Test 8: Script must use process.stdin (the cross-platform fix)
echo -n "  uses process.stdin stream API: "
if grep -q "process.stdin" "${TARGET}"; then
    pass
else
    fail "script does not reference process.stdin — fix not applied"
fi

echo "=========================================="
echo "Results: ${PASS} passed, ${FAIL} failed"
[ "${FAIL}" -gt 0 ] && exit 1
exit 0
