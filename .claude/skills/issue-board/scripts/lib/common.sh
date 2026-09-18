# common.sh — gitlab-issue shared infrastructure.
# Sourced by the entry script. Provides: defaults, git remote derivation,
# init_env (credential/API URL/PROJECT_ID + optional gitlab_group), parse_args.
#
# NOTE: API request helpers (api_get/api_put) have moved to lib/http.sh as
# http_get/http_get_all/http_put/http_post. This file no longer sources curl
# directly — cmd_*.sh call http_* + endpoint_* instead.

# ─── Defaults (before parse_args runs) ───

SEVERITY=""
DIMENSION=""
FORMAT="table"
ASSIGNEE=""
AUTHOR_FILTER=""
LABELS_TO_SET=""
# LABELS_FILTER 同时承载两种语义：list 命令用作过滤条件（cmd_list.sh:44），
# update 命令用作待写入的标签集合（cmd_update.sh:40）。一个变量两用以保持参数名统一。
LABELS_FILTER=""
DUE_DATE=""
IID=""
ALL_ISSUES=false
MR_REF=""
COMMENT_BODY=""

# milestone / group scope defaults (new)
GROUP_PATH=""
GROUP_ID=""
MILESTONE_IID=""
MILESTONE_STATE="opened"

# --project <path>: explicitly target a project other than the cwd-derived one.
# Empty → current repo (backward compatible). Set → scope_resolve derives that
# project's id, so cross-project issue ops are deterministic (no silent
# iid-collision mis-targeting).
PROJECT_PATH=""

# Scope kind/id are populated by scope_resolve (see lib/scope.sh). Initialized
# here so `set -u` never trips on an uninitialised reference.
SCOPE_KIND=""
SCOPE_ID=""

# ─── git remote derivation ───

_derive_remote_url() {
  git remote get-url origin 2>/dev/null \
    || git remote get-url public 2>/dev/null \
    || git remote get-url "$(git remote 2>/dev/null | head -1)" 2>/dev/null \
    || true
}

_derive_project_id() {
  local remote_url project_path encoded_path
  remote_url="$(_derive_remote_url)"
  if [ -z "${remote_url}" ]; then
    return 1
  fi
  if [[ "${remote_url}" =~ ^((https?)://[^/]+)/(.+)\.git$ ]]; then
    project_path="${BASH_REMATCH[3]}"
  elif [[ "${remote_url}" =~ ^git@[^:]+:(.+)\.git$ ]]; then
    project_path="${BASH_REMATCH[1]}"
  elif [[ "${remote_url}" =~ ^((https?)://[^/]+)/(.+)$ ]]; then
    project_path="${BASH_REMATCH[3]}"
  elif [[ "${remote_url}" =~ ^git@[^:]+:(.+)$ ]]; then
    project_path="${BASH_REMATCH[1]}"
  fi
  if [ -n "${project_path}" ]; then
    encoded_path=$(echo "${project_path}" | sed 's/\//%2F/g')
    PROJECT_ID=$(curl -s --max-time 10 --header "PRIVATE-TOKEN: ${TOKEN}" \
      "${API_URL}/projects/${encoded_path}" 2>/dev/null | json_get 'id' '' || true)
  fi
}

# ─── init_env (credentials, API_URL, PROJECT_ID, optional gitlab_group) ───

init_env() {
  TOKEN="${GITLAB_TOKEN:-}"
  API_URL="${GITLAB_API_URL:-${CI_API_V4_URL:-}}"
  PROJECT_ID="${GITLAB_PROJECT_ID:-${CI_PROJECT_ID:-}}"

  # Local mode: read .gitlab-config if present (and we still need values).
  local CONFIG_FILE=".gitlab-config"
  if [ -f "${CONFIG_FILE}" ] && ([ -z "${TOKEN}" ] || [ -z "${API_URL}" ] || [ -z "${PROJECT_ID}" ]); then
    while IFS='=' read -r key value; do
      [[ "${key}" =~ ^#.*$ || -z "${key}" ]] && continue
      value=$(echo "${value}" | xargs)  # trim whitespace
      case "${key}" in
        gitlab_token)             [ -z "${TOKEN}" ] && TOKEN="${value}" ;;
        gitlab_api_url)           [ -z "${API_URL}" ] && API_URL="${value}" ;;
        gitlab_project_id)        [ -z "${PROJECT_ID}" ] && PROJECT_ID="${value}" ;;
        gitlab_group)             GROUP_PATH="${value}" ;;   # new: optional default group
        DAILY_REPORT_GITLAB_URL)  [ -z "${API_URL}" ] && API_URL="${value}" ;;
        DAILY_REPORT_PROJECT_ID)  [ -z "${PROJECT_ID}" ] && PROJECT_ID="$(echo "${value}" | sed 's|%2F|/|g')" ;;
      esac
    done < "${CONFIG_FILE}"
  fi

  # Normalize API_URL: ensure /api/v4 suffix.
  if [ -n "${API_URL}" ] && [[ "${API_URL}" != */api/v4 ]]; then
    API_URL="${API_URL%/}/api/v4"
  fi

  # Derive API_URL from git remote if still unknown.
  if [ -z "${API_URL}" ] || [ -z "${PROJECT_ID}" ]; then
    local remote_url
    remote_url="$(_derive_remote_url)"
    if [ -n "${remote_url}" ]; then
      if [[ "${remote_url}" =~ ^((https?)://([^/]+))/(.+)\.git$ ]]; then
        [ -z "${API_URL}" ] && API_URL="${BASH_REMATCH[1]}/api/v4"
      elif [[ "${remote_url}" =~ ^git@([^:]+):(.+)\.git$ ]]; then
        [ -z "${API_URL}" ] && API_URL="https://${BASH_REMATCH[1]}/api/v4"
      elif [[ "${remote_url}" =~ ^((https?)://([^/]+))/(.+)$ ]]; then
        [ -z "${API_URL}" ] && API_URL="${BASH_REMATCH[1]}/api/v4"
      elif [[ "${remote_url}" =~ ^git@([^:]+):(.+)$ ]]; then
        [ -z "${API_URL}" ] && API_URL="https://${BASH_REMATCH[1]}/api/v4"
      fi
    fi
  fi

  if [ -z "${TOKEN}" ]; then
    echo "[gitlab-issue] Error: GITLAB_TOKEN not set" >&2
    echo "  export GITLAB_TOKEN=\"your-token\"" >&2
    echo "  # or create .gitlab-config: gitlab_token=your-token" >&2
    exit 1
  fi

  # Prefer project id derived from git remote (overrides config-supplied value
  # that may belong to a different project). Backward compatible.
  if local _remote="$(_derive_remote_url)" && [ -n "${_remote}" ]; then
    _derive_project_id
  fi

  if [ -z "${API_URL}" ]; then
    echo "[gitlab-issue] Error: cannot determine GitLab API address" >&2
    exit 1
  fi
  if [ -z "${PROJECT_ID}" ]; then
    echo "[gitlab-issue] Error: cannot determine project ID" >&2
    exit 1
  fi
}

# ─── parse_args ───

# Usage text (shared between -h at position 0 and mid-args -h/--help).
_print_usage() {
  echo "用法:"
  echo "  gitlab-issue.sh list [--severity P0|P1|P2] [--dimension security] [--assignee user] [--author user] [--labels 'label1,label2'] [--all] [--format table|json]"
  echo "  gitlab-issue.sh get <iid> [--project <path>] [--format json]"
  echo "  gitlab-issue.sh update <iid> [--project <path>] [--assignee user] [--labels 'P1,new-label'] [--due-date 2026-06-30]"
  echo "  gitlab-issue.sh close <iid> [--project <path>] [--mr MR_IID]"
  echo "  gitlab-issue.sh comment <iid> --body 'text' [--project <path>]"
  echo "  gitlab-issue.sh milestone <group_path> <milestone_iid> [--state opened|closed|all] [--format json|table]"
  echo ""
  echo "  选项说明:"
  echo "    --all        查询所有 Issue（不限定 ai-detected 标签）"
  echo "    --author     按作者用户名过滤（如 wangzk、suqiang），用于下游用户查看自己提交的 issue 状态"
  echo "    --labels     按自定义标签过滤（逗号分隔，AND 逻辑）"
  echo "    --project   显式指定目标 project（如 UniData/630-campaign）。跨项目 issue 操作务必带，避免误操作当前仓库的同 iid issue"
  echo "    --group      指定 group path（milestone 命令的位置参数会覆盖此值）"
  echo "    --state      milestone 状态过滤（opened|closed|all，默认 opened）"
}

parse_args() {
  # -h / --help as the very first arg: print usage and exit before CMD dispatch.
  if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
    _print_usage
    exit 0
  fi

  CMD="${1:-list}"
  shift || true

  # milestone takes two positional args: <group_path> <milestone_iid>.
  if [ "${CMD}" = "milestone" ]; then
    GROUP_PATH="${1:-}"
    shift || true
    MILESTONE_IID="${1:-}"
    shift || true
    if [ -z "${GROUP_PATH}" ] || [ -z "${MILESTONE_IID}" ]; then
      echo "用法: gitlab-issue.sh milestone <group_path> <milestone_iid> [--state opened|closed|all] [--format json|table]" >&2
      exit 1
    fi
    # milestone's default format is JSON (the cross-project rendering contract).
    FORMAT="json"
  fi

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --severity) SEVERITY="$2"; shift 2 ;;
      --dimension) DIMENSION="$2"; shift 2 ;;
      --format) FORMAT="$2"; shift 2 ;;
      --assignee) ASSIGNEE="$2"; shift 2 ;;
      --author) AUTHOR_FILTER="$2"; shift 2 ;;
      --labels)
        # list 命令用作过滤（cmd_list.sh:44 检查 LABELS_FILTER），
        # update 命令用作待写入标签（cmd_update.sh:40 检查 LABELS_FILTER）。
        # 同一个变量两种语义，按 CMD 区分使用方。
        LABELS_FILTER="$2"; shift 2 ;;
      --mr) MR_REF="$2"; shift 2 ;;
      --body) COMMENT_BODY="$2"; shift 2 ;;
      --due-date) DUE_DATE="$2"; shift 2 ;;
      --state) MILESTONE_STATE="$2"; shift 2 ;;   # new (milestone)
      --group) GROUP_PATH="$2"; shift 2 ;;          # new (default group for milestone/list)
      --project) PROJECT_PATH="$2"; shift 2 ;;      # new (deterministic cross-project target)
      --all) ALL_ISSUES=true; shift ;;
      -h|--help)
        _print_usage
        exit 0 ;;
      *)
        # Only non-milestone commands treat the first positional as IID.
        # (milestone already consumed its two positionals above.)
        [ "${CMD}" != "milestone" ] && IID="$1"
        shift ;;
    esac
  done
}
