#!/usr/bin/env bash
# PreToolUse hook: 记忆路由门禁
# 1. 拦截对 MEMORY.md 的错误写入：user/feedback 索引不得出现在项目级，project/reference 索引不得出现在用户级
# 2. 写入 .harness/memory/ 下记忆文件时，校验 MEMORY.md 索引同步
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/hook-json-helper.sh"

# 用户级记忆目录（默认 ~/.claude/projects；generator 为 codex/codebuddy 注入 HARNESS_PROJECTS_DIR）
# HARNESS_PROJECTS_DIR 可能含字面 `$HOME`（settings.json env 块，bash 不展开单引号内的 $HOME），
# 用 _expand_home（定义在 hook-json-helper.sh）展开为真实 $HOME，
# 否则后续路径段比较 (grep -F "$PROJECTS_SEGMENT") 与 ~/ 替换会失配。
_raw_projects_dir="${HARNESS_PROJECTS_DIR:-$HOME/${HARNESS_ROOT:-.claude}/projects}"
PROJECTS_DIR="$(_expand_home "$_raw_projects_dir")"
PROJECTS_SEGMENT="$PROJECTS_DIR"
PROJECTS_DISPLAY="${PROJECTS_DIR/#$HOME/~}"

INPUT=$(cat)
TOOL=$(_jq_val "$INPUT" tool_name)

# 只拦截 Write 和 Edit
[[ "$TOOL" != "Write" && "$TOOL" != "Edit" ]] && exit 0

FILE_PATH=$(_jq_val "$INPUT" file_path)
[ -z "$FILE_PATH" ] && exit 0

# 提取写入内容字段（仅检查用户实际写入的文本，排除 JSON 元数据中的路径）
_get_write_content() {
    local ns os fc
    ns=$(_jq_raw "$1" new_string)
    os=$(_jq_raw "$1" old_string)
    fc=$(_jq_raw "$1" content)
    printf '%s%s%s' "$ns" "$os" "$fc"
}

# ── 场景1: 写入 MEMORY.md — 路由校验 ──

if [[ "$FILE_PATH" == */MEMORY.md || "$FILE_PATH" == */memory/MEMORY.md ]]; then

    ERROR_MSG=""
    WRITE_CONTENT=$(_get_write_content "$INPUT")

    # 用户级 MEMORY.md（<HARNESS_PROJECTS_DIR>/...）
    if echo "$FILE_PATH" | grep -qF "$PROJECTS_SEGMENT"; then
        # 检查写入内容是否包含 .harness/memory/ 路径
        if printf '%s' "$WRITE_CONTENT" | grep -q '\.harness/memory/'; then
            ERROR_MSG="路由违规：用户级 MEMORY.md 禁止引用 .harness/memory/ 路径。
   project/reference 类型记忆应写入 .harness/memory/MEMORY.md"
        fi
    fi

    # 项目级 MEMORY.md（.harness/memory/）
    if echo "$FILE_PATH" | grep -q '/\.harness/memory/'; then
        # 检查写入内容是否包含用户级记忆路径（<HARNESS_PROJECTS_DIR>/...）
        if printf '%s' "$WRITE_CONTENT" | grep -qF "$PROJECTS_SEGMENT"; then
            ERROR_MSG="路由违规：项目级 MEMORY.md 禁止引用 ${PROJECTS_DISPLAY} 路径。
   user/feedback 类型记忆应写入 ${PROJECTS_DISPLAY}/.../MEMORY.md"
        fi
    fi

    if [ -n "$ERROR_MSG" ]; then
        hook_deny "$ERROR_MSG"
    fi

    exit 0
fi

# ── 场景2: 写入 .harness/memory/ 下记忆文件 — 索引同步校验 ──

if echo "$FILE_PATH" | grep -q '/\.harness/memory/'; then
    # 排除 MEMORY.md 自身（已在场景1处理）
    [[ "$(basename "$FILE_PATH")" == "MEMORY.md" ]] && exit 0

    # 找到对应的 MEMORY.md
    MEMORY_DIR=$(dirname "$FILE_PATH")
    # 如果文件在 .harness/memory/ 子目录下，向上找到 memory 目录
    while [[ "$(basename "$MEMORY_DIR")" != "memory" ]] && [[ "$MEMORY_DIR" != "/" ]]; do
        MEMORY_DIR=$(dirname "$MEMORY_DIR")
    done
    [[ "$MEMORY_DIR" == "/" ]] && exit 0

    MEMORY_INDEX="$MEMORY_DIR/MEMORY.md"

    # 如果 MEMORY.md 不存在，创建空文件
    if [ ! -f "$MEMORY_INDEX" ]; then
        mkdir -p "$MEMORY_DIR"
        printf "# MEMORY.md\n" > "$MEMORY_INDEX"
    fi

    # 提取文件名（不含路径）
    FILENAME=$(basename "$FILE_PATH")

    # 校验索引中是否包含该文件名
    if ! grep -q "$FILENAME" "$MEMORY_INDEX" 2>/dev/null; then
        ERROR_MSG="索引缺失：$FILENAME 未在 MEMORY.md 中注册。
   写入记忆文件前必须先在 MEMORY.md 添加索引条目。
   格式: - [标题]($FILENAME) — 一行说明"
        hook_deny "$ERROR_MSG"
    fi
fi

exit 0
