#!/usr/bin/env bash
# resolve-harness-projects.sh — .harness-projects 统一解析入口
#
# 查找策略：CWD 优先 → 祖先链兜底 → HARNESS_PROJECTS_FILE 环境变量覆盖
# 输出 JSON 到 stdout，退出码 0 成功 / 1 未找到清单
#
# 用法:
#   bash resolve-harness-projects.sh                  # 输出完整 JSON
#   bash resolve-harness-projects.sh --source-path-only  # 仅输出清单文件路径
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── 参数解析 ──
SOURCE_PATH_ONLY=false
if [ "${1:-}" = "--source-path-only" ]; then
    SOURCE_PATH_ONLY=true
fi

# ── 查找 .harness-projects ──
fname="${HARNESS_PROJECTS_FILE:-.harness-projects}"
source_file=""

# 1) CWD 优先
if [ -f "./$fname" ]; then
    source_file="$(readlink -f "./$fname" 2>/dev/null || realpath "./$fname" 2>/dev/null || { _d="$(cd "$(dirname "./$fname")" 2>/dev/null && pwd)"; echo "${_d}/$(basename "./$fname")"; })"
fi

# 2) 祖先链兜底（从 SCRIPT_DIR 向上）
if [ -z "$source_file" ]; then
    _ancestor_dir="$SCRIPT_DIR"
    while [ "$_ancestor_dir" != "/" ]; do
        if [ -f "$_ancestor_dir/$fname" ]; then
            source_file="$(readlink -f "$_ancestor_dir/$fname" 2>/dev/null || realpath "$_ancestor_dir/$fname" 2>/dev/null || echo "$_ancestor_dir/$fname")"
            break
        fi
        _ancestor_dir="$(dirname "$_ancestor_dir")"
    done
fi

# 3) 环境变量覆盖（兜底）
if [ -z "$source_file" ] && [ -n "${HARNESS_PROJECTS_FILE:-}" ] && [ -f "${HARNESS_PROJECTS_FILE}" ]; then
    source_file="$(readlink -f "${HARNESS_PROJECTS_FILE}" 2>/dev/null || realpath "${HARNESS_PROJECTS_FILE}" 2>/dev/null || echo "${HARNESS_PROJECTS_FILE}")"
fi

# 未找到
if [ -z "$source_file" ]; then
    echo "未找到 .harness-projects" >&2
    exit 1
fi

# ── --source-path-only 模式 ──
if [ "$SOURCE_PATH_ONLY" = true ]; then
    echo "$source_file"
    exit 0
fi

# ── 辅助：JSON 字符串转义（处理 " 和 \） ──
_json_escape() {
    local s="$1"
    s="${s//\\/\\\\}"
    s="${s//\"/\\\"}"
    printf '%s' "$s"
}

# ── 解析清单文件 ──
projects_dir="$(cd "$(dirname "$source_file")" && pwd)"
count=0
valid_count=0
projects_json=""

while IFS= read -r raw || [ -n "$raw" ]; do
    # 跳过空行和注释行（# 或 ; 开头）
    case "$raw" in
        ''|\#*|\;*) continue ;;
    esac
    # 去除首尾空白
    raw="${raw#"${raw%%[![:space:]]*}"}"
    raw="${raw%"${raw##*[![:space:]]}"}"
    [ -z "$raw" ] && continue

    count=$((count + 1))

    # 解析绝对路径：绝对路径直接使用，相对路径相对于清单文件目录
    case "$raw" in
        /*) abs_path="$raw" ;;
        *)  abs_path="$projects_dir/$raw" ;;
    esac

    # 规范化路径
    abs_path="$(cd "$(dirname "$abs_path")" 2>/dev/null && pwd 2>/dev/null)/$(basename "$abs_path")" || abs_path="$abs_path"

    # 检测 exists 和 has_harness
    _exists=false
    _has_harness=false
    [ -d "$abs_path" ] && _exists=true
    [ -d "$abs_path/${HARNESS_ROOT:-.claude}" ] && _has_harness=true

    if [ "$_exists" = true ] && [ "$_has_harness" = true ]; then
        valid_count=$((valid_count + 1))
    fi

    # 构建项目 JSON 对象（纯 bash，无 jq 依赖）
    _item_path="$(_json_escape "$abs_path")"
    _item_relative="$(_json_escape "$raw")"
    _item="{\"path\": \"${_item_path}\", \"relative\": \"${_item_relative}\", \"exists\": ${_exists}, \"has_harness\": ${_has_harness}}"

    if [ -z "$projects_json" ]; then
        projects_json="$_item"
    else
        projects_json="${projects_json},${_item}"
    fi
done < "$source_file"

# ── 输出最终 JSON（纯 bash printf，无 jq 依赖） ──
_source_escaped="$(_json_escape "$source_file")"
printf '{"source": "%s", "projects": [%s], "count": %d, "valid_count": %d}\n' \
    "$_source_escaped" "$projects_json" "$count" "$valid_count"

exit 0
