#!/usr/bin/env bash
# spec-index.sh — SPEC Index 自动生成工具（纯 bash，无 Python 依赖）
#
# 用法:
#   bash .claude/tools/scripts/misc/spec-index.sh generate          # 生成 index.md
#   bash .claude/tools/scripts/misc/spec-index.sh generate --dry-run # 预览，不写文件
#   bash .claude/tools/scripts/misc/spec-index.sh list               # 列出所有 SPEC 条目

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
SPEC_ROOT="$PROJECT_ROOT/.harness/spec"
INDEX_FILE="$SPEC_ROOT/index.md"

# ─── 解析 YAML frontmatter ───

frontmatter_get() {
  local file="$1" key="$2"
  sed -n '/^---$/,/^---$/p' "$file" 2>/dev/null \
    | grep "^${key}:" | head -1 \
    | sed "s/^${key}:[[:space:]]*//" | sed 's/[[:space:]]*$//' | tr -d '"'"'"
}

# ─── 扫描 SPEC 文件 ───

scan_specs() {
  [[ -d "$SPEC_ROOT" ]] || return 0

  while IFS= read -r -d '' md_file; do
    [[ "$(basename "$md_file")" == "_meta.md" ]] && continue

    local spec_id module feature status version author updated_at rel_path
    spec_id=$(frontmatter_get "$md_file" "spec_id")
    [[ -z "$spec_id" ]] && continue

    module=$(frontmatter_get "$md_file" "module")
    [[ -z "$module" ]] && module=$(basename "$(dirname "$md_file")")
    feature=$(frontmatter_get "$md_file" "feature")
    [[ -z "$feature" ]] && feature=$(basename "$md_file" .md)
    status=$(frontmatter_get "$md_file" "status")
    [[ -z "$status" ]] && status="draft"
    version=$(frontmatter_get "$md_file" "version")
    [[ -z "$version" ]] && version="v1.0"
    author=$(frontmatter_get "$md_file" "author")
    updated_at=$(frontmatter_get "$md_file" "updated_at")
    rel_path=$(realpath --relative-to="$SPEC_ROOT" "$md_file")

    echo "${spec_id}	${module}	${feature}	${status}	${version}	${author}	${updated_at}	${rel_path}"
  done < <(find "$SPEC_ROOT" -mindepth 2 -name "*.md" -print0 | sort -z)
}

# ─── 状态 emoji ───

status_emoji() {
  case "$1" in
    draft)       echo "📝 draft" ;;
    review)      echo "🔍 review" ;;
    debate)      echo "⚔️ debate" ;;
    approved)    echo "✅ approved" ;;
    implemented) echo "🚀 implemented" ;;
    archived)    echo "📦 archived" ;;
    *)           echo "$1" ;;
  esac
}

# ─── 生成 index.md ───

cmd_generate() {
  local dry_run="${1:-false}"
  local now
  now=$(date "+%Y-%m-%d %H:%M")

  {
    echo "# SPEC 状态总览"
    echo ""
    echo "> **CI 自动生成，禁止手动编辑。**"
    echo ""
    echo "生成时间：${now}"
    echo ""

    local entries
    entries=$(scan_specs)

    if [[ -z "$entries" ]]; then
      echo "| 模块 | L1 架构 | SPEC 数量 | 全部 Approved |"
      echo "|------|---------|-----------|---------------|"
      echo "| — | — | — | — |"
      echo ""
    else
      # 按模块汇总
      echo "| 模块 | L1 架构 | SPEC 数量 | 全部 Approved |"
      echo "|------|---------|-----------|---------------|"

      # 按模块汇总（兼容 Bash 3.2 / macOS，不使用 declare -A）
      modules=$(echo "$entries" | cut -f2 | sort -u)
      while IFS= read -r mod; do
        [ -z "$mod" ] && continue
        local count=0 approved=0 has_l1=0
        while IFS=$'\t' read -r spec_id module feature status version author updated_at rel_path; do
          [[ "$module" != "$mod" ]] && continue
          count=$((count + 1))
          [[ "$status" == "approved" || "$status" == "implemented" || "$status" == "archived" ]] && approved=$((approved + 1))
          [[ "$rel_path" == *"/architecture-"* ]] && has_l1=1
        done <<< "$entries"
        local l1_icon="❌" approved_icon="❌"
        [[ "$has_l1" -eq 1 ]] && l1_icon="✅"
        [[ "$approved" -eq "$count" ]] && approved_icon="✅"
        echo "| ${mod} | ${l1_icon} | ${count} | ${approved_icon} |"
      done <<< "$modules"
      echo ""

      # 详细列表
      echo "## 详细状态"
      echo ""
      echo "| SPEC ID | 模块 | 功能 | 状态 | 版本 | 作者 | 更新时间 |"
      echo "|---------|------|------|------|------|------|----------|"

      while IFS=$'\t' read -r spec_id module feature status version author updated_at rel_path; do
        local se
        se=$(status_emoji "$status")
        echo "| ${spec_id} | ${module} | ${feature} | ${se} | ${version} | ${author} | ${updated_at} |"
      done <<< "$entries"
      echo ""
    fi

    echo "<!-- CI 会在每次 push 时自动扫描 .harness/spec/ 下所有模块目录并更新此表 -->"
    echo ""
  } > /dev/stdout | {
    if [[ "$dry_run" == "true" ]]; then
      cat
      echo ""
      echo "（dry-run 模式，未写入文件）"
    else
      cat > "$INDEX_FILE"
      local count
      count=$(scan_specs | wc -l)
      echo "✅ 已生成 ${INDEX_FILE}（${count} 个 SPEC 条目）"
    fi
  }
}

# ─── 列出所有条目 ───

cmd_list() {
  local entries
  entries=$(scan_specs)

  if [[ -z "$entries" ]]; then
    echo "无 SPEC 条目"
    return 0
  fi

  printf "%-10s %-15s %-20s %-12s %-6s %-8s %-12s\n" "SPEC ID" "模块" "功能" "状态" "版本" "作者" "更新时间"
  echo "-------------------------------------------------------------------------------------"

  while IFS=$'\t' read -r spec_id module feature status version author updated_at rel_path; do
    printf "%-10s %-15s %-20s %-12s %-6s %-8s %-12s\n" \
      "$spec_id" "$module" "$feature" "$status" "$version" "$author" "$updated_at"
  done <<< "$entries"
}

# ─── 主入口 ───

case "${1:-}" in
  generate)
    if [[ "${2:-}" == "--dry-run" ]]; then
      cmd_generate "true"
    else
      cmd_generate "false"
    fi
    ;;
  list)
    cmd_list
    ;;
  *)
    echo "用法: bash .claude/tools/scripts/misc/spec-index.sh {generate [--dry-run] | list}"
    exit 1
    ;;
esac
