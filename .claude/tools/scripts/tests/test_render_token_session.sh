#!/usr/bin/env bash
# Tests for render-report.js Token 用量取 session 维度 (Issue !158)
#
# 背景：render-report.js 第 ~497 行原取 total_input_tokens / total_output_tokens
#   （dispatch 维度，只统计 sub-agent 调度），导致日报工作量统计 Token 用量远低于
#   实际消耗。session 维度（session_input_tokens / session_output_tokens）含主会话，
#   是更准确的口径。
#
# 本测试覆盖：
#   1) PASS: summary 含 session_input/output_tokens → 渲染用 session 值
#   2) PASS: session_output_tokens 维度单独生效（不被 total_output 污染）
#   3) PASS: summary 同时含 dispatch 和 session → 用 session（不是 dispatch）
#   4) PASS: summary 缺 session 字段（旧数据兼容）→ fallback 0（不崩）
#
# 测试以集成方式：造 fixture date/user/repo/tasks/git/kanban/ai JSON，
# 跑 render-report.js，读输出 markdown，验证 "Token 用量" 行。
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RENDER_JS="${SCRIPT_DIR}/../../../skills/daily-report/scripts/render-report.js"

PASS=0
FAIL=0
CLEANUP_DIRS=""

cleanup() {
    for d in ${CLEANUP_DIRS}; do
        [ -n "${d}" ] && rm -rf "${d}"
    done
}
trap cleanup EXIT

if [ ! -f "${RENDER_JS}" ]; then
    echo "SKIP: render-report.js not found at ${RENDER_JS}"
    exit 1
fi

# 公共 fixture（date/user/repo/tasks/git/kanban 都一致）
write_common_fixtures() {
    local dir="$1"
    echo '[]' > "${dir}/tasks.json"
    cat > "${dir}/git.json" <<'EOF'
{
  "stats": { "commits": 0, "files_changed": 0, "insertions": 0, "deletions": 0 },
  "classification": {
    "ai_independent": { "count": 0, "hashes": [] },
    "ai_collaborative": { "count": 0, "hashes": [] },
    "human": { "count": 0, "hashes": [] }
  },
  "tags": {},
  "commits": []
}
EOF
    cat > "${dir}/kanban.json" <<'EOF'
{
  "source_file": "kanban.md",
  "user": { "name": "Test User", "group": "Dev" },
  "tasks": [],
  "stats": { "total": 0, "done": 0, "in_progress": 0, "not_started": 0 },
  "deadline_calendar": { "overdue": [] }
}
EOF
}

# 造 ai.json
# 参数: session_in session_out total_in total_out include_session(0/1)
write_ai_fixture() {
    local dir="$1"
    local session_in="$2"
    local session_out="$3"
    local total_in="$4"
    local total_out="$5"
    local include_session="$6"

    local session_io_block=""
    if [ "${include_session}" = "1" ]; then
        session_io_block="\"session_input_tokens\": ${session_in}, \"session_output_tokens\": ${session_out},"
    fi

    # 注意：summary 字段必须完整，schema 校验 + renderAiSection() 都依赖。
    # 形状取自 emptyAiSection()，仅 token 字段参数化。
    cat > "${dir}/ai.json" <<EOF
{
  "date": "2026-07-04",
  "tasks": [],
  "summary": {
    ${session_io_block}
    "session_cache_creation_input_tokens": 0,
    "session_cache_read_input_tokens": 0,
    "session_count": 0,
    "session_by_project": {},
    "session_by_model": {},
    "total_input_tokens": ${total_in},
    "total_output_tokens": ${total_out},
    "total_dispatches": 0,
    "total_wall_clock_ms": 0,
    "dispatch_by_trigger": {
      "pipeline": {
        "dispatch_count": 0, "input_tokens": 0, "output_tokens": 0,
        "cache_read_tokens": 0, "cache_creation_tokens": 0, "by_role": {}, "by_model": {}
      },
      "natural": {
        "dispatch_count": 0, "input_tokens": 0, "output_tokens": 0,
        "cache_read_tokens": 0, "cache_creation_tokens": 0, "by_role": {}, "by_model": {}
      }
    },
    "spec_stats": { "total_changes": 0, "closed_loop": 0, "open": 0, "by_phase": {} },
    "concern_stats": { "total": 0, "p0_found": 0, "p0_closed": 0, "p1_found": 0, "p1_closed": 0 }
  }
}
EOF
}

# 跑 render-report.js，输出 markdown 到 ${dir}/report.md
run_render() {
    local dir="$1"
    node "${RENDER_JS}" \
        "--date=2026-07-04" \
        "--user=tester" \
        "--repo=test-repo" \
        "--branch=main" \
        "--group=test-group" \
        "--tasks=@${dir}/tasks.json" \
        "--git=@${dir}/git.json" \
        "--kanban=${dir}/kanban.json" \
        "--ai=@${dir}/ai.json" \
        "--output=${dir}/report.md" \
        "--json-output=${dir}/report.json" 2>&1
}

# 从 markdown 提取 "Token 用量" 行的数值（去掉千分位逗号）
extract_token_value() {
    local md="$1"
    grep -E '^\| Token 用量' "${md}" 2>/dev/null | sed -E 's/.*\| *([0-9,]+) *\|.*/\1/' | tr -d ','
}

echo "render-report.js token session-dimension tests (Issue !158)"
echo "================================================"

# ─── case 1: PASS — session_input/output_tokens 存在 → 用 session 值 ───
T1="$(mktemp -d)"
CLEANUP_DIRS="${CLEANUP_DIRS} ${T1}"
write_common_fixtures "${T1}"
# session_in=12000, session_out=4000 → 期望 16000
# total_in=3000, total_out=1000 → dispatch 维度（错误口径）会得到 4000
write_ai_fixture "${T1}" 12000 4000 3000 1000 1
OUT1="$(run_render "${T1}")"
if [ ! -f "${T1}/report.md" ]; then
    echo "  case 1: FAIL — render-report.js 没产出 markdown。stderr: ${OUT1}"
    FAIL=$((FAIL + 1))
else
    TOKEN1="$(extract_token_value "${T1}/report.md")"
    if [ "${TOKEN1}" = "16000" ]; then
        echo "  case 1 (session_input/output_tokens → 用 session 值): PASS"
        PASS=$((PASS + 1))
    else
        echo "  case 1 (session_input/output_tokens → 用 session 值): FAIL — got '${TOKEN1}', expected '16000'"
        FAIL=$((FAIL + 1))
    fi
fi

# ─── case 2: PASS — session_output_tokens 维度单独生效 ───
# session_in=0, session_out=5000, total_in=9999, total_out=9999
# 期望 = 0 + 5000 = 5000（证明不会把 total_output 9999 混入）
T2="$(mktemp -d)"
CLEANUP_DIRS="${CLEANUP_DIRS} ${T2}"
write_common_fixtures "${T2}"
write_ai_fixture "${T2}" 0 5000 9999 9999 1
OUT2="$(run_render "${T2}")"
if [ ! -f "${T2}/report.md" ]; then
    echo "  case 2: FAIL — render-report.js 没产出 markdown。stderr: ${OUT2}"
    FAIL=$((FAIL + 1))
else
    TOKEN2="$(extract_token_value "${T2}/report.md")"
    if [ "${TOKEN2}" = "5000" ]; then
        echo "  case 2 (session_output_tokens 维度生效): PASS"
        PASS=$((PASS + 1))
    else
        echo "  case 2 (session_output_tokens 维度生效): FAIL — got '${TOKEN2}', expected '5000'"
        FAIL=$((FAIL + 1))
    fi
fi

# ─── case 3: PASS — dispatch 和 session 都有 → 用 session 不是 dispatch ───
T3="$(mktemp -d)"
CLEANUP_DIRS="${CLEANUP_DIRS} ${T3}"
write_common_fixtures "${T3}"
# session_in=20000, session_out=8000 → 期望 28000
# total_in=3000, total_out=1300 → dispatch 维度会得到 4300（错误口径）
write_ai_fixture "${T3}" 20000 8000 3000 1300 1
OUT3="$(run_render "${T3}")"
if [ ! -f "${T3}/report.md" ]; then
    echo "  case 3: FAIL — render-report.js 没产出 markdown。stderr: ${OUT3}"
    FAIL=$((FAIL + 1))
else
    TOKEN3="$(extract_token_value "${T3}/report.md")"
    if [ "${TOKEN3}" = "28000" ]; then
        echo "  case 3 (dispatch+session 都有 → 用 session 不是 dispatch): PASS"
        PASS=$((PASS + 1))
    else
        echo "  case 3 (dispatch+session 都有 → 用 session 不是 dispatch): FAIL — got '${TOKEN3}', expected '28000'"
        FAIL=$((FAIL + 1))
    fi
fi

# ─── case 4: PASS — session 字段值为 0（或缺失字段兜底）→ 总量为 0，不被 total_* 接管 ───
# 说明：daily-report 的 ai.summary schema 强制要求 session_input/output_tokens 字段存在，
# 所以"缺失"场景在 schema 层已被挡；此 case 验证 session_*_tokens=0 时显示 0，
# 而不是退回 total_*（避免维度再次混乱）。
T4="$(mktemp -d)"
CLEANUP_DIRS="${CLEANUP_DIRS} ${T4}"
write_common_fixtures "${T4}"
# session_in=0, session_out=0；total_in=3000, total_out=1000
# 期望: 0 + 0 = 0（不是 4000）
write_ai_fixture "${T4}" 0 0 3000 1000 1
OUT4="$(run_render "${T4}")"
if [ ! -f "${T4}/report.md" ]; then
    echo "  case 4: FAIL — render-report.js 没产出 markdown。stderr: ${OUT4}"
    FAIL=$((FAIL + 1))
else
    TOKEN4="$(extract_token_value "${T4}/report.md")"
    if [ "${TOKEN4}" = "0" ]; then
        echo "  case 4 (session 字段为 0 → 显示 0，不退回 total_*): PASS"
        PASS=$((PASS + 1))
    else
        echo "  case 4 (session 字段为 0 → 显示 0，不退回 total_*): FAIL — got '${TOKEN4}', expected '0'"
        FAIL=$((FAIL + 1))
    fi
fi

echo "================================================"
echo "Results: ${PASS} passed, ${FAIL} failed"
if [ "${FAIL}" -gt 0 ]; then
    exit 1
fi
exit 0
