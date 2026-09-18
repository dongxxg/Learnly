#!/usr/bin/env bash
# Unit tests for lib/endpoint.sh — pure endpoint builders + endpoint_query helper.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LIB_DIR="${SCRIPT_DIR}/../lib"

# endpoint.sh needs scope.sh for scope_prefix; seed scope globals.
PROJECT_ID="42"
GROUP_ID="7"
SCOPE_KIND=""
# shellcheck disable=SC1091
source "${LIB_DIR}/scope.sh"
# shellcheck disable=SC1091
source "${LIB_DIR}/endpoint.sh"

PASS=0
FAIL=0
assert_eq() {
  if [ "$1" = "$2" ]; then echo "  PASS: $3"; PASS=$((PASS+1))
  else echo "  FAIL: $3 — got '$1' want '$2'"; FAIL=$((FAIL+1)); fi
}

echo "test_endpoint.sh"

# ─── endpoint_query ───
echo "  endpoint_query:"
assert_eq "$(endpoint_query)" "" "empty args → empty string"
assert_eq "$(endpoint_query state=opened)" "?state=opened" "single kv → ?kv"
assert_eq "$(endpoint_query state=opened per_page=100)" "?state=opened&per_page=100" "two kv → ?a&b"
assert_eq "$(endpoint_query "" state=opened)" "?state=opened" "blank kv skipped"
assert_eq "$(endpoint_query state=opened "" per_page=100)" "?state=opened&per_page=100" "middle blank skipped"

# ─── endpoint_issues ───
echo "  endpoint_issues:"
{
  SCOPE_KIND="project"; PROJECT_ID="42"
  assert_eq "$(endpoint_issues)" "/projects/42/issues" "project issues"
}
{
  SCOPE_KIND="group"; GROUP_ID="7"
  assert_eq "$(endpoint_issues)" "/groups/7/issues" "group issues"
}

# ─── endpoint_issue (single) ───
echo "  endpoint_issue:"
{
  SCOPE_KIND="project"; PROJECT_ID="42"
  assert_eq "$(endpoint_issue 5)" "/projects/42/issues/5" "project single issue"
}

# ─── endpoint_milestones / endpoint_milestone / endpoint_milestone_issues ───
echo "  endpoint_milestones:"
{
  SCOPE_KIND="group"; GROUP_ID="7"
  assert_eq "$(endpoint_milestones)" "/groups/7/milestones" "group milestones list"
  assert_eq "$(endpoint_milestone 15)" "/groups/7/milestones/15" "group single milestone"
  assert_eq "$(endpoint_milestone_issues 15)" "/groups/7/milestones/15/issues" "group milestone issues"
}

# ─── endpoint_users (global, no scope) ───
echo "  endpoint_users:"
assert_eq "$(endpoint_users)" "/users" "users is global"

# ─── endpoint_issue_notes ───
echo "  endpoint_issue_notes:"
{
  SCOPE_KIND="project"; PROJECT_ID="42"
  assert_eq "$(endpoint_issue_notes 5)" "/projects/42/issues/5/notes" "project issue notes"
}

echo "Results: ${PASS} passed, ${FAIL} failed"
if [ "${FAIL}" -gt 0 ]; then exit 1; fi
exit 0
