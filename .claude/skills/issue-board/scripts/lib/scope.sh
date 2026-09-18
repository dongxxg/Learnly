# scope.sh — Scope abstraction (project | group | global).
#
# Globals (set by init_env / parse_args, mutated by scope_resolve):
#   SCOPE_KIND  — "project" (default) | "group" | "global"
#   SCOPE_ID    — PROJECT_ID or GROUP_ID (empty for global)
#   GROUP_PATH  — user-supplied group path (e.g. "UniData", "UniData/backend")
#   GROUP_ID    — derived numeric id; cached after first derivation
#
# Design: group id is derived LAZILY (only when scope_resolve group is called),
# so the default project flow never pays the extra API round-trip.

# scope_prefix — echo the REST path prefix for the current scope.
#   project → "/projects/<PROJECT_ID>"
#   group   → "/groups/<GROUP_ID>"
#   global  → "" (no prefix; for resources like /users)
scope_prefix() {
  case "${SCOPE_KIND}" in
    project) echo "/projects/${SCOPE_ID:-${PROJECT_ID}}" ;;
    group)   echo "/groups/${GROUP_ID}" ;;
    global)  echo "" ;;
    *)       echo "" ;;
  esac
}

# scope_resolve KIND [PATH]
#   project — reuse PROJECT_ID (already derived by init_env)
#   group   — derive GROUP_ID from PATH on first use, then cache
#   global  — empty id (top-level resources)
scope_resolve() {
  local kind="$1" path="${2:-}"
  SCOPE_KIND="${kind}"
  case "${kind}" in
    project)
      # Honor --project <path>: derive that project's id, overriding the
      # cwd-derived PROJECT_ID. Without this, `close 10` silently hits whatever
      # repo cwd is in — and since iids repeat across projects, the wrong issue
      # could be closed. --project makes the target explicit & deterministic.
      if [ -n "${PROJECT_PATH:-}" ]; then
        PROJECT_ID=$(_derive_project_id_by_path "${PROJECT_PATH}")
      fi
      SCOPE_ID="${PROJECT_ID}"
      ;;
    group)
      if [ -z "${GROUP_ID}" ]; then
        GROUP_ID=$(_derive_group_id "${path}")
      fi
      SCOPE_ID="${GROUP_ID}"
      ;;
    global)
      SCOPE_ID=""
      ;;
  esac
}

# _derive_group_id PATH — URL-encode the path and GET /groups/:enc, return .id.
# Mirrors bootstrap.py:69-71's "GET /groups/<url-encoded-path>" approach. Uses
# python3 urllib.parse.quote for encoding so nested paths (UniData/backend →
# UniData%2Fbackend) and special characters are handled. Replaces jq @uri.
#
# Errors (group not found / no access) print to stderr and exit 1.
_derive_group_id() {
  local path="$1" enc resp id
  enc=$(printf '%s' "${path}" | json_url_encode)
  if ! resp=$(http_get "/groups/${enc}"); then
    echo "[gitlab-issue] Error: group '${path}' not found or no access" >&2
    exit 1
  fi
  id=$(printf '%s' "${resp}" | json_get 'id' '')
  if [ -z "${id}" ]; then
    echo "[gitlab-issue] Error: group '${path}' has no id" >&2
    exit 1
  fi
  echo "${id}"
}

# _derive_project_id_by_path PATH — URL-encode the path and GET /projects/:enc,
# return .id. Used when --project explicitly targets a repo other than cwd.
# Same shape as _derive_group_id. Errors (not found / no access) exit 1.
_derive_project_id_by_path() {
  local path="$1" enc resp id
  enc=$(printf '%s' "${path}" | json_url_encode)
  if ! resp=$(http_get "/projects/${enc}"); then
    echo "[gitlab-issue] Error: project '${path}' not found or no access" >&2
    exit 1
  fi
  id=$(printf '%s' "${resp}" | json_get 'id' '')
  if [ -z "${id}" ]; then
    echo "[gitlab-issue] Error: project '${path}' has no id" >&2
    exit 1
  fi
  echo "${id}"
}

# _issue_ref IID — human-readable ref that includes the project path when
# --project was used, so success messages show exactly which project's issue was
# touched (deterministic — no silent iid-collision ambiguity). Falls back to
# "!<iid>" for the default cwd-repo flow (backward compatible).
_issue_ref() {
  local iid="$1"
  if [ -n "${PROJECT_PATH:-}" ]; then
    echo "${PROJECT_PATH}#${iid}"
  else
    echo "!${iid}"
  fi
}
