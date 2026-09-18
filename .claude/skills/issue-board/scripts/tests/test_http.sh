#!/usr/bin/env bash
# Unit tests for lib/http.sh — http_get / http_get_all / http_put / http_post
# and the private _http_check_error / _http_request.
#
# curl is shadowed by tests/bin/curl (fake) via PATH injection so it survives
# the $(...) subshells that http_get_all relies on.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LIB_DIR="${SCRIPT_DIR}/../lib"

# Bring in the code under test.
TOKEN="test-token-fake"
API_URL="https://gitlab.example.com/api/v4"
# shellcheck disable=SC1091
source "${LIB_DIR}/json.sh"
# shellcheck disable=SC1091
source "${LIB_DIR}/http.sh"

PASS=0
FAIL=0

assert_eq() {  # actual expected msg
  if [ "$1" = "$2" ]; then
    echo "  PASS: $3"
    PASS=$((PASS+1))
  else
    echo "  FAIL: $3 — got '$1' want '$2'"
    FAIL=$((FAIL+1))
  fi
}
assert_contains() {  # haystack needle msg
  if [[ "$1" == *"$2"* ]]; then
    echo "  PASS: $3"
    PASS=$((PASS+1))
  else
    echo "  FAIL: $3 — '$2' not in '$1'"
    FAIL=$((FAIL+1))
  fi
}
assert_not_contains() {  # haystack needle msg
  if [[ "$1" != *"$2"* ]]; then
    echo "  PASS: $3"
    PASS=$((PASS+1))
  else
    echo "  FAIL: $3 — '$2' unexpectedly in '$1'"
    FAIL=$((FAIL+1))
  fi
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

teardown_mock() {
  rm -f "${MOCK_CURL_CALL_LOG}" 2>/dev/null || true
}

echo "test_http.sh"

# ─── _http_check_error (pure, no curl) ───
echo "  _http_check_error:"
{
  HDR="$(mktemp)"; printf 'HTTP/1.1 404 Not Found\r\n' >"${HDR}"
  err=$(_http_check_error '{"message":"404 Not Found"}' "${HDR}" GET /groups/x 2>&1 >/dev/null; echo "rc=$?")
  assert_contains "${err}" "HTTP 404" "404 status surfaces message"
  assert_contains "${err}" "404 Not Found" "error body message included"
  rm -f "${HDR}"
}
{
  HDR="$(mktemp)"; printf 'HTTP/1.1 200 OK\r\n' >"${HDR}"
  err=$(_http_check_error '<html>not json</html>' "${HDR}" GET /x 2>&1 >/dev/null; echo "rc=$?")
  assert_contains "${err}" "non-JSON" "non-JSON 2xx body is flagged"
  rm -f "${HDR}"
}
{
  HDR="$(mktemp)"; printf 'HTTP/1.1 200 OK\r\n' >"${HDR}"
  out=$(_http_check_error '{"id":1}' "${HDR}" GET /x 2>&1; echo "rc=$?")
  assert_eq "${out}" "rc=0" "valid JSON 2xx passes"
  rm -f "${HDR}"
}

# ─── http_get single page ───
echo "  http_get single page:"
setup_mock
{
  BODY_FILE="$(mktemp)"; printf '{"id":7,"name":"UniData"}' >"${BODY_FILE}"
  export MOCK_CURL_RESPONSE_FILE="${BODY_FILE}"
  export MOCK_CURL_STATUS=200
  out=$(http_get "/groups/7")
  rc=$?
  assert_eq "${rc}" "0" "http_get returns 0 on 200 JSON"
  assert_contains "${out}" '"id":7' "http_get body echoed"
  # Verify curl was invoked with PRIVATE-TOKEN header and the full URL.
  call=$(head -1 "${MOCK_CURL_CALL_LOG}")
  assert_contains "${call}" "PRIVATE-TOKEN: test-token-fake" "TOKEN header sent"
  assert_contains "${call}" "https://gitlab.example.com/api/v4/groups/7" "full URL assembled"
  rm -f "${BODY_FILE}"
}
teardown_mock

# ─── http_get with HTTP error ───
echo "  http_get HTTP 404:"
setup_mock
{
  BODY_FILE="$(mktemp)"; printf '{"message":"404 Group Not Found"}' >"${BODY_FILE}"
  export MOCK_CURL_RESPONSE_FILE="${BODY_FILE}"
  export MOCK_CURL_STATUS=404
  out=$(http_get "/groups/NoSuchGroup" 2>/dev/null); rc=$?
  assert_eq "${rc}" "1" "http_get returns 1 on 404"
  rm -f "${BODY_FILE}"
}
teardown_mock

# ─── http_get_all pagination (X-Next-Page present then absent) ───
echo "  http_get_all multi-page:"
setup_mock
{
  PAGE1="$(mktemp)"; printf '[{"iid":1},{"iid":2}]' >"${PAGE1}"
  PAGE2="$(mktemp)"; printf '[{"iid":3}]' >"${PAGE2}"

  # Fake response function selects fixture by page= query param in the args.
  mock_by_page() {
    local args="$1"
    if [[ "${args}" == *"page=2"* ]]; then
      cat "${PAGE2}"
    else
      cat "${PAGE1}"
    fi
  }
  export -f mock_by_page
  export PAGE1 PAGE2
  export MOCK_CURL_RESPONSE_FN=mock_by_page

  HDR_NEXT="$(mktemp)"
  {
    printf 'HTTP/1.1 200 OK\r\n'
    printf 'X-Next-Page: 2\r\n'
  } >"${HDR_NEXT}"
  HDR_LAST="$(mktemp)"
  {
    printf 'HTTP/1.1 200 OK\r\n'
    printf 'X-Next-Page:\r\n'
  } >"${HDR_LAST}"

  # Response function: pick body by page AND write the matching headers directly
  # to $MOCK_CURL_HEADERS_OUT (the -D target). This is how per-page X-Next-Page
  # varies across calls inside http_get_all's $(...) subshells.
  staging_headers() {
    local args="$1"
    if [[ "${args}" == *"page=2"* ]]; then
      cp "${HDR_LAST}" "${MOCK_CURL_HEADERS_OUT}"
      cat "${PAGE2}"
    else
      cp "${HDR_NEXT}" "${MOCK_CURL_HEADERS_OUT}"
      cat "${PAGE1}"
    fi
  }
  export -f staging_headers
  export HDR_NEXT HDR_LAST
  export MOCK_CURL_RESPONSE_FN=staging_headers

  out=$(http_get_all "/groups/7/issues?per_page=100")
  rc=$?
  assert_eq "${rc}" "0" "http_get_all multi-page returns 0"
  total=$(printf '%s' "${out}" | json_len)
  assert_eq "${total}" "3" "two pages merged into 3 items"
  # Verify two curl calls were made (one per page).
  call_count=$(wc -l <"${MOCK_CURL_CALL_LOG}")
  assert_eq "${call_count}" "2" "exactly 2 curl calls for pagination"
  rm -f "${PAGE1}" "${PAGE2}" "${HDR_NEXT}" "${HDR_LAST}"
}
teardown_mock

# ─── http_get_all single page (no X-Next-Page) ───
echo "  http_get_all single page (no next):"
setup_mock
{
  ONE_PAGE="$(mktemp)"; printf '[{"iid":1}]' >"${ONE_PAGE}"
  export MOCK_CURL_RESPONSE_FILE="${ONE_PAGE}"
  HDR="$(mktemp)"
  {
    printf 'HTTP/1.1 200 OK\r\n'
    printf 'X-Next-Page:\r\n'
  } >"${HDR}"
  export MOCK_CURL_HEADERS_FILE="${HDR}"
  out=$(http_get_all "/groups/7/issues?per_page=100"); rc=$?
  assert_eq "${rc}" "0" "single-page returns 0"
  total=$(printf '%s' "${out}" | json_len)
  assert_eq "${total}" "1" "single page has 1 item"
  call_count=$(wc -l <"${MOCK_CURL_CALL_LOG}")
  assert_eq "${call_count}" "1" "only 1 curl call when no next page"
  rm -f "${ONE_PAGE}" "${HDR}"
}
teardown_mock

# ─── http_put body forwarding ───
echo "  http_put forwards body:"
setup_mock
{
  BODY_FILE="$(mktemp)"; printf '{"iid":5}' >"${BODY_FILE}"
  export MOCK_CURL_RESPONSE_FILE="${BODY_FILE}"
  export MOCK_CURL_STATUS=200
  out=$(http_put "/projects/1/issues/5" '{"state_event":"close"}'); rc=$?
  assert_eq "${rc}" "0" "http_put returns 0"
  call=$(head -1 "${MOCK_CURL_CALL_LOG}")
  assert_contains "${call}" '-X PUT' "PUT method used"
  assert_contains "${call}" '--data {"state_event":"close"}' "PUT body forwarded"
  assert_contains "${call}" "Content-Type: application/json" "Content-Type set"
  rm -f "${BODY_FILE}"
}
teardown_mock

# ─── http_post body forwarding ───
echo "  http_post forwards body:"
setup_mock
{
  BODY_FILE="$(mktemp)"; printf '{"id":99}' >"${BODY_FILE}"
  export MOCK_CURL_RESPONSE_FILE="${BODY_FILE}"
  export MOCK_CURL_STATUS=201
  out=$(http_post "/projects/1/issues/5/notes" '{"body":"hi"}'); rc=$?
  assert_eq "${rc}" "0" "http_post returns 0"
  call=$(head -1 "${MOCK_CURL_CALL_LOG}")
  assert_contains "${call}" '-X POST' "POST method used"
  assert_contains "${call}" '--data {"body":"hi"}' "POST body forwarded"
  rm -f "${BODY_FILE}"
}
teardown_mock

echo "Results: ${PASS} passed, ${FAIL} failed"
if [ "${FAIL}" -gt 0 ]; then exit 1; fi
exit 0
