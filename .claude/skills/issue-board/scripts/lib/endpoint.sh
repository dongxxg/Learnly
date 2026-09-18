# endpoint.sh — Pure endpoint builders.
#
# Each function returns a COMPLETE relative path (including scope prefix from
# scope_prefix) but WITHOUT a leading API_URL and WITHOUT a query string.
# Callers compose the final endpoint as:
#     "$(endpoint_issues)$(endpoint_query state=opened per_page=100)"
# This keeps URL construction centralized and unit-testable without curl.

# endpoint_query KV [KV ...]
# Join key=value fragments into "?k1=v1&k2=v2". Empty fragments are skipped.
# Returns empty string when no non-empty fragments are supplied.
endpoint_query() {
  local first=1 out=""
  local kv
  for kv in "$@"; do
    [ -z "${kv}" ] && continue
    if [ ${first} -eq 1 ]; then
      out="?${kv}"
      first=0
    else
      out="${out}&${kv}"
    fi
  done
  printf '%s' "${out}"
}

# Issues collection — project or group scope.
endpoint_issues() {
  printf '%s/issues' "$(scope_prefix)"
}

# Single issue by iid (project scope only in current usage).
# $1 = iid
endpoint_issue() {
  printf '%s/issues/%s' "$(scope_prefix)" "$1"
}

# Milestones collection (typically group scope for cross-project milestones).
endpoint_milestones() {
  printf '%s/milestones' "$(scope_prefix)"
}

# Single milestone by API id (not iid).
# $1 = milestone id
endpoint_milestone() {
  printf '%s/milestones/%s' "$(scope_prefix)" "$1"
}

# Issues under a milestone (cross-project when group scope).
# $1 = milestone id
endpoint_milestone_issues() {
  printf '%s/milestones/%s/issues' "$(scope_prefix)" "$1"
}

# Users — global resource (no scope prefix). Callers add ?username=...
endpoint_users() {
  printf '/users'
}

# Issue notes (comments) — issue sub-resource (project scope).
# $1 = iid
endpoint_issue_notes() {
  printf '%s/issues/%s/notes' "$(scope_prefix)" "$1"
}
