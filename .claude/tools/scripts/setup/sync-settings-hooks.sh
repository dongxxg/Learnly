#!/usr/bin/env bash
# sync-settings-hooks.sh — 将框架 settings.json 中的 hooks 合并到项目 settings.json
# 用法: bash .claude/tools/scripts/setup/sync-settings-hooks.sh [框架源目录]
#   框架源目录默认: /tmp/rd_harness_upgrade
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
SOURCE_DIR="${1:-/tmp/rd_harness_upgrade}"

FRAMEWORK_SETTINGS="$SOURCE_DIR/.claude/settings.json"
PROJECT_SETTINGS="$PROJECT_ROOT/.claude/settings.json"

if [ ! -f "$FRAMEWORK_SETTINGS" ]; then
    echo "[sync-settings-hooks] 框架 settings.json 不存在: $FRAMEWORK_SETTINGS"
    exit 0
fi

# 若项目无 settings.json，直接复制框架的
if [ ! -f "$PROJECT_SETTINGS" ]; then
    cp "$FRAMEWORK_SETTINGS" "$PROJECT_SETTINGS"
    echo "[sync-settings-hooks] 已创建 settings.json（从框架复制）"
    exit 0
fi

# 用 jq 合并：保留项目所有配置，仅覆盖 hooks 为框架版本；env 用框架补缺失项（项目同 key 优先）
# permissions 等项目自定义字段完全保留
jq -s '
    .[0] as $fw | .[1] as $proj |
    $proj * {
      "env":   (($fw.env // {}) * ($proj.env // {})),
      "hooks": $fw.hooks
    }
' "$FRAMEWORK_SETTINGS" "$PROJECT_SETTINGS" > "${PROJECT_SETTINGS}.tmp" \
    && mv "${PROJECT_SETTINGS}.tmp" "$PROJECT_SETTINGS"

echo "[sync-settings-hooks] 已合并框架 hooks 到 settings.json"
