#!/usr/bin/env bash
# Unit tests for parse_args (defined in lib/common.sh).
#
# parse_args reads positional + flag args and mutates globals (CMD, IID, etc).
# We reset all relevant globals before each call so tests are independent.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LIB_DIR="${SCRIPT_DIR}/../lib"

# parse_args lives in common.sh but common.sh also defines init_env which does
# network/git work. We only need parse_args here, so source common.sh in a
# subshell-friendly way and never call init_env.

reset_globals() {
  SEVERITY=""; DIMENSION=""; FORMAT="table"; ASSIGNEE=""
  LABELS_TO_SET=""; LABELS_FILTER=""; DUE_DATE=""
  IID=""; ALL_ISSUES=false; MR_REF=""
  GROUP_PATH=""; GROUP_ID=""; MILESTONE_IID=""; MILESTONE_STATE="opened"
  PROJECT_PATH=""
  CMD=""
}

PASS=0
FAIL=0
assert_eq() {
  if [ "$1" = "$2" ]; then echo "  PASS: $3"; PASS=$((PASS+1))
  else echo "  FAIL: $3 — got '$1' want '$2'"; FAIL=$((FAIL+1)); fi
}
assert_contains() {
  if [[ "$1" == *"$2"* ]]; then echo "  PASS: $3"; PASS=$((PASS+1))
  else echo "  FAIL: $3 — '$2' not in '$1'"; FAIL=$((FAIL+1)); fi
}

# Source common.sh once to load function definitions. parse_args is pure after that.
# shellcheck disable=SC1090
source "${LIB_DIR}/common.sh"

echo "test_parse_args.sh"

# ─── default command (list) ───
echo "  default cmd:"
{
  reset_globals
  parse_args
  assert_eq "${CMD}" "list" "no args → cmd=list"
  assert_eq "${FORMAT}" "table" "default format=table"
}

# ─── existing flags regression ───
echo "  existing flags:"
{
  reset_globals
  parse_args list --severity P0 --dimension security --format json --all
  assert_eq "${CMD}" "list" "cmd=list"
  assert_eq "${SEVERITY}" "P0" "severity captured"
  assert_eq "${DIMENSION}" "security" "dimension captured"
  assert_eq "${FORMAT}" "json" "format=json"
  assert_eq "${ALL_ISSUES}" "true" "--all set"
}
{
  reset_globals
  parse_args list --assignee alice --labels "P1,bug" --due-date 2026-06-30
  assert_eq "${ASSIGNEE}" "alice" "assignee captured"
  assert_eq "${LABELS_FILTER}" "P1,bug" "labels filter captured"
}
{
  reset_globals
  parse_args get 5
  assert_eq "${CMD}" "get" "cmd=get"
  assert_eq "${IID}" "5" "positional iid captured for get"
}
{
  reset_globals
  parse_args update 7 --assignee bob --labels "X" --due-date 2026-12-31
  assert_eq "${CMD}" "update" "cmd=update"
  assert_eq "${IID}" "7" "update iid"
  assert_eq "${ASSIGNEE}" "bob" "update assignee"
  assert_eq "${LABELS_FILTER:-}" "X" "update --labels writes to LABELS_FILTER (cmd_update consumes same var)"
}
{
  reset_globals
  parse_args close 9 --mr '!12'
  assert_eq "${CMD}" "close" "cmd=close"
  assert_eq "${IID}" "9" "close iid"
  assert_eq "${MR_REF}" "!12" "close --mr captured"
}

# ─── milestone positional args ───
echo "  milestone positional:"
{
  reset_globals
  parse_args milestone UniData 2
  assert_eq "${CMD}" "milestone" "cmd=milestone"
  assert_eq "${GROUP_PATH}" "UniData" "milestone group_path positional"
  assert_eq "${MILESTONE_IID}" "2" "milestone iid positional"
  assert_eq "${IID}" "" "milestone does not populate IID"
  assert_eq "${MILESTONE_STATE}" "opened" "default milestone state=opened"
  assert_eq "${FORMAT}" "json" "milestone default format=json"
}
{
  reset_globals
  parse_args milestone "UniData/backend" 5 --state all --format table
  assert_eq "${GROUP_PATH}" "UniData/backend" "nested group path"
  assert_eq "${MILESTONE_IID}" "5" "iid from positional"
  assert_eq "${MILESTONE_STATE}" "all" "--state captured"
  assert_eq "${FORMAT}" "table" "--format captured"
}

# ─── --group flag (for future list --group reuse) ───
echo "  --group flag:"
{
  reset_globals
  parse_args list --group UniData
  assert_eq "${GROUP_PATH}" "UniData" "--group sets GROUP_PATH"
  assert_eq "${CMD}" "list" "cmd still list"
}

# ─── --project flag (deterministic cross-project target) ───
echo "  --project flag:"
{
  reset_globals
  parse_args get 5 --project "UniData/630-campaign"
  assert_eq "${PROJECT_PATH}" "UniData/630-campaign" "--project captured"
  assert_eq "${IID}" "5" "iid still captured"
}
{
  reset_globals
  parse_args close 10 --project "UniData/630-campaign" --mr '!12'
  assert_eq "${PROJECT_PATH}" "UniData/630-campaign" "close --project"
  assert_eq "${IID}" "10" "close iid"
  assert_eq "${MR_REF}" "!12" "close --mr still works"
}

# ─── milestone missing positional args → error ───
echo "  milestone missing args:"
{
  reset_globals
  set +e
  err=$(parse_args milestone UniData 2>&1 >/dev/null)
  rc=$?
  set -e
  # Only one positional → should error. (With our implementation, missing 2nd
  # positional triggers the usage error.)
  assert_eq "${rc}" "1" "milestone with only group_path errors"
  assert_contains "${err}" "milestone" "error mentions milestone usage"
}

# ─── -h / --help prints usage including milestone ───
echo "  -h / --help:"
{
  reset_globals
  set +e
  out=$(parse_args -h 2>&1)
  rc=$?
  set -e
  assert_eq "${rc}" "0" "-h exits 0"
  assert_contains "${out}" "milestone" "usage mentions milestone"
  assert_contains "${out}" "--project" "usage mentions --project"
}
{
  reset_globals
  set +e
  out=$(parse_args --help 2>&1)
  rc=$?
  set -e
  assert_eq "${rc}" "0" "--help exits 0"
  assert_contains "${out}" "milestone" "--help mentions milestone"
}

echo "Results: ${PASS} passed, ${FAIL} failed"
if [ "${FAIL}" -gt 0 ]; then exit 1; fi
exit 0
