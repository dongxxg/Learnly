# http.sh — GitLab HTTP client layer.
#
# Exposes: http_get / http_get_all / http_put / http_post
# Private: _http_request (unified curl invocation) / _http_check_error.
#
# Designed so that callers pass a COMPLETE relative endpoint (already assembled
# by endpoint.sh including scope prefix + query string). This layer only adds:
#   - API_URL base + TOKEN header + Content-Type for write methods
#   - curl timeouts/retries (CURL_OPTS)
#   - HTTP error checking (replaces the old silent 2>/dev/null)
#   - Pagination via the X-Next-Page response header (http_get_all)
#
# Response headers are written to $_HTTP_HEADERS_FILE via curl's -D flag; tests
# rely on this contract (fake curl honors it too).

CURL_OPTS=(-s --max-time 30 --retry 2 --retry-delay 5)

# Headers scratch file. mktemp varies across platforms (GNU vs BSD); try both.
_HTTP_HEADERS_FILE="$(mktemp 2>/dev/null || mktemp -t gitlabissue)"
trap 'rm -f "${_HTTP_HEADERS_FILE}" 2>/dev/null || true' EXIT

# Max pages safety valve to prevent runaway pagination loops.
_HTTP_MAX_PAGES=50

# _http_request METHOD ENDPOINT [DATA]
# stdout: response body. stderr: human-readable error on failure.
# Returns: 0 on success (2xx + JSON body), 1 otherwise.
_http_request() {
  local method="$1" endpoint="$2" data="${3:-}"
  local url="${API_URL}${endpoint}"
  local -a args=("${CURL_OPTS[@]}" -X "${method}"
                 --header "PRIVATE-TOKEN: ${TOKEN}"
                 -D "${_HTTP_HEADERS_FILE}")
  if [ -n "${data}" ]; then
    args+=(--header "Content-Type: application/json" --data "${data}")
  fi

  local body
  if ! body=$(curl "${args[@]}" "${url}"); then
    echo "[gitlab-issue] Error: curl failed for ${method} ${url}" >&2
    return 1
  fi

  _http_check_error "${body}" "${_HTTP_HEADERS_FILE}" "${method}" "${endpoint}" || return 1
  printf '%s' "${body}"
}

# _http_check_error BODY HEADER_FILE METHOD ENDPOINT
# Surfaces HTTP error status and non-JSON responses (the old api_* silently
# swallowed these via 2>/dev/null). Returns 1 on error, 0 on a healthy response.
_http_check_error() {
  local body="$1" hdr="$2" method="$3" endpoint="$4"
  local status=""
  if [ -f "${hdr}" ]; then
    # Strip CR (CRLF headers from curl) before parsing the status code.
    status=$(grep -i '^HTTP/' "${hdr}" 2>/dev/null | tr -d '\r' | tail -1 | awk '{print $2}' || true)
  fi
  if [ -n "${status}" ] && [ "${status}" -ge 400 ] 2>/dev/null; then
    local msg
    msg=$(printf '%s' "${body}" | json_py '
import sys, json
try:
    d = json.load(sys.stdin)
    if isinstance(d, dict):
        v = d.get("message") or d.get("error") or "unknown"
        print(v)
    else:
        print("unknown")
except Exception:
    print("non-json error body")
' 2>/dev/null || echo "non-json error body")
    echo "[gitlab-issue] Error: ${method} ${endpoint} → HTTP ${status}: ${msg}" >&2
    return 1
  fi
  # 2xx but body isn't valid JSON → token expired / wrong API URL / HTML login page.
  if ! printf '%s' "${body}" | python3 -c '
import sys, json
try:
    json.load(sys.stdin)
except Exception:
    sys.exit(1)
' 2>/dev/null; then
    echo "[gitlab-issue] Error: ${method} ${endpoint} → non-JSON response (token expired? API URL wrong?)" >&2
    return 1
  fi
  return 0
}

# http_get ENDPOINT → body (single page)
http_get() {
  _http_request GET "$1"
}

# http_get_all ENDPOINT — paginate by following X-Next-Page.
# ENDPOINT must already contain a query string (per_page=...). The page=N
# parameter is injected per call. Results are merged with python3 into one JSON array.
http_get_all() {
  local endpoint="$1"
  local page=1 all="[]" pages_seen=0
  while :; do
    pages_seen=$((pages_seen+1))
    if [ "${pages_seen}" -gt "${_HTTP_MAX_PAGES}" ]; then
      echo "[gitlab-issue] Error: pagination exceeded ${_HTTP_MAX_PAGES} pages at ${endpoint}" >&2
      return 1
    fi
    local ep sub next
    if [[ "${endpoint}" == *"?"* ]]; then
      ep="${endpoint}&page=${page}"
    else
      ep="${endpoint}?page=${page}"
    fi
    sub=$(_http_request GET "${ep}") || return 1
    # Merge accumulator with this page (both are arrays).
    all=$(ALL="${all}" SUB="${sub}" python3 -c '
import sys, json, os
# !261: GBK 终端 stdin/stdout 都重配置 utf-8——stdin 按 utf-8 解 JSON，stdout 打印中文标题（ensure_ascii=False）
for _s in ("stdin", "stdout"):
    _st = getattr(sys, _s, None)
    _r = getattr(_st, "reconfigure", None)
    if _r is not None:
        try: _r(encoding="utf-8", errors="replace")
        except Exception: pass
a = json.loads(os.environ["ALL"]) if os.environ.get("ALL") else []
s = json.loads(os.environ["SUB"]) if os.environ.get("SUB") else []
if not isinstance(a, list): a = []
if not isinstance(s, list): s = []
print(json.dumps(a + s, ensure_ascii=False))
')
    # Read X-Next-Page header from the scratch file populated by _http_request.
    next=""
    if [ -f "${_HTTP_HEADERS_FILE}" ]; then
      next=$(grep -i '^x-next-page:' "${_HTTP_HEADERS_FILE}" 2>/dev/null | tail -1 | tr -d '\r' | awk '{print $2}' || true)
    fi
    [ -z "${next}" ] && break
    [ "${next}" = "${page}" ] && break  # safety: page didn't advance
    page="${next}"
  done
  printf '%s' "${all}"
}

# http_put ENDPOINT DATA
http_put() {
  _http_request PUT "$1" "$2"
}

# http_post ENDPOINT DATA
http_post() {
  _http_request POST "$1" "$2"
}
