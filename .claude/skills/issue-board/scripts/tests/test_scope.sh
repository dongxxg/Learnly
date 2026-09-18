#!/usr/bin/env bash
# Unit tests for lib/scope.sh — scope_resolve / scope_prefix / _derive_group_id.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LIB_DIR="${SCRIPT_DIR}/../lib"

TOKEN="t"
API_URL="https://gitlab.example.com/api/v4"
PROJECT_ID="42"
# Reset scope-related globals scope.sh reads/writes.
GROUP_PATH=""
GROUP_ID=""
SCOPE_KIND=""
SCOPE_ID=""

# shellcheck disable=SC1091
source "${LIB_DIR}/json.sh"
# shellcheck disable=SC1091
source "${LIB_DIR}/http.sh"
# shellcheck disable=SC1091
source "${LIB_DIR}/scope.sh"

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

setup_mock() {
  export PATH="${SCRIPT_DIR}/bin:${PATH}"
  export MOCK_CURL_CALL_LOG="$(mktemp)"
  export MOCK_CURL_HEADERS_FILE=""
  export MOCK_CURL_RESPONSE_FILE=""
  export MOCK_CURL_RESPONSE_FN=""
  export MOCK_CURL_STATUS=""
  : >"${MOCK_CURL_CALL_LOG}"
}
teardown_mock() { rm -f "${MOCK_CURL_CALL_LOG}" 2>/dev/null || true; }

echo "test_scope.sh"

# ─── scope_prefix ───
echo "  scope_prefix:"
{
  SCOPE_KIND="project"; PROJECT_ID="42"
  assert_eq "$(scope_prefix)" "/projects/42" "project scope prefix"
}
{
  SCOPE_KIND="group"; GROUP_ID="7"
  assert_eq "$(scope_prefix)" "/groups/7" "group scope prefix"
}
{
  SCOPE_KIND="global"
  assert_eq "$(scope_prefix)" "" "global scope has empty prefix"
}

# ─── scope_resolve project (no network) ───
echo "  scope_resolve project:"
{
  GROUP_ID=""; SCOPE_ID=""
  scope_resolve project
  assert_eq "${SCOPE_KIND}" "project" "project kind set"
  assert_eq "${SCOPE_ID}" "42" "project id copied from PROJECT_ID"
  assert_eq "${GROUP_ID}" "" "group id not touched for project scope"
}

# ─── scope_resolve group with cached GROUP_ID ───
echo "  scope_resolve group (cached):"
{
  SCOPE_KIND=""; SCOPE_ID=""; GROUP_ID="99"
  scope_resolve group "SomeGroup"
  assert_eq "${SCOPE_ID}" "99" "uses cached GROUP_ID without network call"
  assert_eq "${SCOPE_KIND}" "group" "group kind set"
}

# ─── scope_resolve group derives GROUP_ID via http_get ───
echo "  scope_resolve group (derives id):"
setup_mock
{
  GROUP_ID=""  # force derivation
  BODY="$(mktemp)"; printf '{"id":7,"name":"UniData"}' >"${BODY}"
  export MOCK_CURL_RESPONSE_FILE="${BODY}"
  export MOCK_CURL_STATUS=200
  scope_resolve group "UniData"
  assert_eq "${GROUP_ID}" "7" "derived GROUP_ID from API"
  assert_eq "${SCOPE_ID}" "7" "SCOPE_ID reflects derived group id"
  # URL encoding: "UniData" → "UniData" (no slash), but verify the encoded path is used.
  call=$(head -1 "${MOCK_CURL_CALL_LOG}")
  assert_contains "${call}" "/groups/UniData" "GET /groups/<path> called"
  rm -f "${BODY}"
}
teardown_mock

# ─── _derive_group_id URL-encodes slashes ───
echo "  _derive_group_id encodes nested path:"
setup_mock
{
  BODY="$(mktemp)"; printf '{"id":55}' >"${BODY}"
  export MOCK_CURL_RESPONSE_FILE="${BODY}"
  export MOCK_CURL_STATUS=200
  id=$(_derive_group_id "UniData/backend")
  assert_eq "${id}" "55" "nested group path resolved"
  call=$(head -1 "${MOCK_CURL_CALL_LOG}")
  assert_contains "${call}" "UniData%2Fbackend" "slash URL-encoded in path"
  rm -f "${BODY}"
}
teardown_mock

# ─── _derive_group_id error: group not found (404) ───
echo "  _derive_group_id 404:"
setup_mock
{
  BODY="$(mktemp)"; printf '{"message":"404 Group Not Found"}' >"${BODY}"
  export MOCK_CURL_RESPONSE_FILE="${BODY}"
  export MOCK_CURL_STATUS=404
  # _derive_group_id exits 1 (not return) on failure; capture rc outside the
  # command substitution so exit doesn't skip the echo.
  set +e
  err=$(_derive_group_id "NoSuchGroup" 2>&1 >/dev/null)
  rc=$?
  set -e
  assert_eq "${rc}" "1" "missing group exits 1"
  assert_contains "${err}" "NoSuchGroup" "error mentions group name"
  rm -f "${BODY}"
}
teardown_mock

# ─── scope_prefix prefers SCOPE_ID, falls back to PROJECT_ID ───
echo "  scope_prefix project (SCOPE_ID fallback):"
{
  SCOPE_KIND="project"; SCOPE_ID="999"; PROJECT_ID="42"
  assert_eq "$(scope_prefix)" "/projects/999" "uses SCOPE_ID when set"
  SCOPE_ID=""
  assert_eq "$(scope_prefix)" "/projects/42" "falls back to PROJECT_ID"
}

# ─── scope_resolve project honors --project <path> ───
echo "  scope_resolve project (--project):"
setup_mock
{
  PROJECT_PATH="UniData/630-campaign"; PROJECT_ID="42"; SCOPE_ID=""
  BODY="$(mktemp)"; printf '{"id":110}' >"${BODY}"
  export MOCK_CURL_RESPONSE_FILE="${BODY}"
  export MOCK_CURL_STATUS=200
  scope_resolve project
  assert_eq "${PROJECT_ID}" "110" "PROJECT_ID overridden by --project"
  assert_eq "${SCOPE_ID}" "110" "SCOPE_ID reflects derived project id"
  call=$(head -1 "${MOCK_CURL_CALL_LOG}")
  assert_contains "${call}" "/projects/UniData%2F630-campaign" "GET /projects/<enc> called"
  PROJECT_PATH=""
  rm -f "${BODY}"
}
teardown_mock

# ─── scope_resolve project without --project stays on current repo ───
echo "  scope_resolve project (no --project, backward compat):"
{
  PROJECT_PATH=""; PROJECT_ID="42"; SCOPE_ID=""
  scope_resolve project
  assert_eq "${PROJECT_ID}" "42" "PROJECT_ID untouched without --project"
  assert_eq "${SCOPE_ID}" "42" "SCOPE_ID = current repo PROJECT_ID"
}

# ─── _derive_project_id_by_path 404 ───
echo "  _derive_project_id_by_path 404:"
setup_mock
{
  BODY="$(mktemp)"; printf '{"message":"404 Not Found"}' >"${BODY}"
  export MOCK_CURL_RESPONSE_FILE="${BODY}"
  export MOCK_CURL_STATUS=404
  set +e
  err=$(_derive_project_id_by_path "NoSuch/Project" 2>&1 >/dev/null)
  rc=$?
  set -e
  assert_eq "${rc}" "1" "missing project exits 1"
  assert_contains "${err}" "NoSuch/Project" "error mentions project name"
  rm -f "${BODY}"
}
teardown_mock

# ─── _issue_ref: deterministic ref shows project when --project used ───
echo "  _issue_ref:"
{
  PROJECT_PATH=""
  assert_eq "$(_issue_ref 7)" "!7" "default ref !<iid>"
  PROJECT_PATH="UniData/630-campaign"
  assert_eq "$(_issue_ref 7)" "UniData/630-campaign#7" "--project ref <path>#<iid>"
  PROJECT_PATH=""
}

echo "Results: ${PASS} passed, ${FAIL} failed"
if [ "${FAIL}" -gt 0 ]; then exit 1; fi
exit 0
