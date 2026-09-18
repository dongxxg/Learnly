#!/usr/bin/env bash
# gitlab-issue.sh — GitLab Issue 查询与管理工具
# 支持本地 CC 和 CI 两种环境。
#
# 用法:
#   gitlab-issue.sh list [--severity P0|P1|P2] [--dimension security] [--format table|json]
#   gitlab-issue.sh get <iid>
#   gitlab-issue.sh update <iid> --assignee username --labels "P1,ai-dimension:code" --due-date 2026-06-30
#   gitlab-issue.sh close <iid> [--mr MR_IID]
#   gitlab-issue.sh comment <iid> --body 'text'
#   gitlab-issue.sh milestone <group_path> <milestone_iid> [--state opened|closed|all] [--format json|table]
#
# 凭证配置（仅需 GITLAB_TOKEN，其余自动推导）:
#   GITLAB_TOKEN — GitLab API token（必须）
#   GITLAB_API_URL / GITLAB_PROJECT_ID — 可选，自动从 git remote 推导
#   .gitlab-config 可选 gitlab_group=... （milestone 命令的默认 group_path）
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Load order matters: common (defaults + init_env + parse_args) first, then
# lib/json.sh (python3-backed JSON helpers, sourced before any lib that calls
# json_get/json_py at runtime), then the layered helpers (http → scope →
# endpoint), then the command implementations.
source "${SCRIPT_DIR}/lib/common.sh"
source "${SCRIPT_DIR}/lib/json.sh"
source "${SCRIPT_DIR}/lib/http.sh"
source "${SCRIPT_DIR}/lib/scope.sh"
source "${SCRIPT_DIR}/lib/endpoint.sh"
source "${SCRIPT_DIR}/lib/cmd_list.sh"
source "${SCRIPT_DIR}/lib/cmd_get.sh"
source "${SCRIPT_DIR}/lib/cmd_update.sh"
source "${SCRIPT_DIR}/lib/cmd_close.sh"
source "${SCRIPT_DIR}/lib/cmd_comment.sh"
source "${SCRIPT_DIR}/lib/cmd_milestone.sh"

# 参数解析（-h|--help 可在 env 初始化前直接返回）
parse_args "$@"

# 初始化 env：加载凭证、推导 API_URL / PROJECT_ID
init_env

# 命令分发
case "${CMD}" in
  list)      cmd_list ;;
  get)       cmd_get ;;
  update)    cmd_update ;;
  close)     cmd_close ;;
  comment)   cmd_comment ;;
  milestone) cmd_milestone ;;
  *)
    echo "[gitlab-issue] Error: unknown command: ${CMD}" >&2
    exit 1 ;;
esac
