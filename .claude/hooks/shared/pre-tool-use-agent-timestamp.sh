#!/usr/bin/env bash
# PreToolUse hook: 记录 Task/Agent 工具调用的开始时间戳。
# 配对 post-tool-use-agent-usage.sh 读取，计算 duration_ms（弥补 CodeBuddy Code 的 PostToolUse
# 输入无 duration_ms 字段的平台 gap）。
#
# 机制：把 started_at 写入 $USAGE_DIR/.pending-<call_id>，PostToolUse 按 call_id 读取并删除。
# 残留文件由本 hook 启动时清理（超过 1 小时的 .pending- 视为崩溃残留）。
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/hook-json-helper.sh"

# 框架根目录与 usage 目录（与 post-tool-use-agent-usage.sh 保持一致）
HARNESS_ROOT="${HARNESS_ROOT:-}"
USAGE_DIR="${HARNESS_USAGE_DIR:-$HOME/${HARNESS_ROOT:-}/usage}"
# HARNESS_USAGE_DIR 由 generator 注入，可能含字面 `$HOME`（settings.json env 块写
# "$HOME/.codebuddy/usage"，bash 不展开单引号内的 $HOME）。展开为 $HOME 真实值，
# 与 post-tool-use-agent-usage.sh 对齐，否则 mkdir -p '$HOME/...' 会在 CWD 下创建
# 字面 `$HOME` 目录。_expand_home 定义在 hook-json-helper.sh。
USAGE_DIR="$(_expand_home "$USAGE_DIR")"

INPUT=$(cat)

# 只处理 Task / Agent 工具
TOOL=$(_jq_val "$INPUT" tool_name)
case "$TOOL" in
    Task|Agent) ;;
    *) exit 0 ;;
esac

# 提取 call_id（PostToolUse 输入也含同名字段，用于配对）
CALL_ID=$(_jq_val "$INPUT" call_id)
[ -z "$CALL_ID" ] && CALL_ID=$(_jq_val "$INPUT" tool_use_id)
[ -z "$CALL_ID" ] && exit 0

# 确保目录存在 + 清理超过 1 小时的崩溃残留（3600 秒）
mkdir -p "$USAGE_DIR" 2>/dev/null || true
find "$USAGE_DIR" -name '.pending-*' -type f -mmin +60 -delete 2>/dev/null || true

# 写入 started_at（ISO 8601，与 orchestrator.js 的 started_at 格式一致）
date -Iseconds > "$USAGE_DIR/.pending-${CALL_ID}" 2>/dev/null || true

exit 0
