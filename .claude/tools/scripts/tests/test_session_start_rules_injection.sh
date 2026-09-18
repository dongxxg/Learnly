#!/usr/bin/env bash
# test_session_start_rules_injection.sh — 4c 规则注入 awk 重写 + 段2 rm 合并 验证
# (optimize-session-start-perf)
#
# 验证：
#   S1: 语法
#   S2: 静态 — per-role grep 循环已移除、awk 已引入、段2 rm 已合并
#   F1: 单元 — 提取源文件中的 awk 块，对真实 harness-rules.yaml 运行，断言 roles 产出正确
#   F2: 集成 — 跑完整 session-start.sh，断言 rules 三段（roles 修正 / QG 等价 / scoring 等价）
#   F3: 修正性 — 旧实现的垃圾行 `**forbidden**: 职责=无 ...` 消失
#
# 背景：原 4c 用 per-role `grep -A1/-A2` 循环（Windows Git Bash 下约 98 次 fork，
# 实测整段 >120s，是 session 启动卡 5~6 分钟的主因）；且外层 `^  [a-z_]+:$` 未限定
# 在 roles: 段、`grep -A` 的 `\s\s` 在 grep 下不可靠，导致产出垃圾（如
# `**forbidden**: 职责=无 禁止=  forbidden:`）。改单次 awk 后：1 次 fork 替代 200+，
# roles 修正为 4 个真实角色，QG/scoring 保持 byte 等价（代码未动）。

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"

SESSION_START="$PROJECT_ROOT/.claude/hooks/shared/session-start.sh"
HARNESS_RULES_YAML="$PROJECT_ROOT/.claude/reference/harness-rules.yaml"

PASS=0
FAIL=0

assert() {
    local label="$1" condition="$2"
    if [ "$condition" = "true" ]; then
        echo "  [PASS] $label"
        PASS=$((PASS+1))
    else
        echo "  [FAIL] $label"
        FAIL=$((FAIL+1))
    fi
}

# ============================================================
# S1: 语法检查
# ============================================================
test_s1_syntax() {
    echo "=== S1: 语法 ==="
    assert "session-start.sh 语法正确" \
           "$(bash -n "$SESSION_START" 2>&1 && echo true || echo false)"
}

# ============================================================
# S2: 静态 — 优化已落地
# ============================================================
test_s2_optimization_landed() {
    echo "=== S2: 优化已落地（静态）==="

    # per-role grep -A 循环已移除（原实现特征：grep -A1/-A2 "^\s\s${role_name}:"）
    # 用 grep -q 判 absence（grep -c 无匹配时打印 0 且退出 1，配 `|| echo 0` 会双输出）
    assert "per-role grep -A 循环已移除（原 Windows 卡顿主因）" \
           "$(! grep -qE 'grep -A[12][[:space:]]+"\\s' "$SESSION_START" && echo true || echo false)"

    # awk 单次扫描已引入
    assert "4c roles 改用 awk 单次扫描" \
           "$(grep -q '_ROLES_AWK_OUT=$(awk' "$SESSION_START" && echo true || echo false)"

    assert "awk 块含 __ROLES_AWK_BEGIN__ 测试锚点" \
           "$(grep -q '__ROLES_AWK_BEGIN__' "$SESSION_START" && echo true || echo false)"

    # 段2 rm 已合并（rm -f 行数 <= 7，原 10）
    local rm_count
    rm_count=$(grep -c 'rm -f' "$SESSION_START" 2>/dev/null || echo 0)
    assert "段2 rm -f 合并后行数 <= 7（原 10，现 $rm_count）" \
           "$([ "$rm_count" -le 7 ] && echo true || echo false)"

    # 段1 版本检测未被误改（篡改检测 sha256 仍在）
    assert "段1 版本检测 sha256 篡改检测保留（未误删安全特性）" \
           "$(grep -q 'sha256sum' "$SESSION_START" && echo true || echo false)"
}

# ============================================================
# F1: 单元 — 提取源文件 awk 块，对真实 harness-rules.yaml 运行
# ============================================================
test_f1_awk_unit() {
    echo "=== F1: 单元 — 源文件 awk 块对真实 harness-rules.yaml ==="

    [ -f "$HARNESS_RULES_YAML" ] || { echo "  [FAIL] harness-rules.yaml 不存在"; FAIL=$((FAIL+1)); return; }

    # 提取 __ROLES_AWK_BEGIN__ .. __ROLES_AWK_END__ 之间的代码块（去掉锚点注释行）
    local block
    block=$(sed -n '/__ROLES_AWK_BEGIN__/,/__ROLES_AWK_END__/p' "$SESSION_START" \
            | grep -v '__ROLES_AWK')
    assert "成功提取 awk 代码块（非空）" \
           "$([ -n "$block" ] && echo true || echo false)"

    # 对真实 rules 运行提取的块（eval 在当前 shell 设置 _ROLES_AWK_OUT）
    local out
    RULES_FILE="$HARNESS_RULES_YAML"
    _ROLES_AWK_OUT=""
    eval "$block" 2>/dev/null || true
    out="$_ROLES_AWK_OUT"

    local role_count
    role_count=$(printf '%s\n' "$out" | grep -c '职责=' || echo 0)
    assert "roles 产出恰好 4 个角色（architect/developer/tester/reviewer）" \
           "$([ "$role_count" = "4" ] && echo true || echo false)"

    assert "含 architect: 职责=system_design, tech_spec, spec_lifecycle, adr" \
           "$(printf '%s' "$out" | grep -q '\*\*architect\*\*: 职责=system_design, tech_spec, spec_lifecycle, adr 禁止=无' && echo true || echo false)"

    assert "含 developer: 职责=implementation, unit_test" \
           "$(printf '%s' "$out" | grep -q '\*\*developer\*\*: 职责=implementation, unit_test 禁止=无' && echo true || echo false)"

    assert "含 tester: 职责=integration_test, regression_test, e2e_test" \
           "$(printf '%s' "$out" | grep -q '\*\*tester\*\*: 职责=integration_test, regression_test, e2e_test 禁止=无' && echo true || echo false)"

    assert "含 reviewer: 职责=code_review, doc_quality, ux_evaluation" \
           "$(printf '%s' "$out" | grep -q '\*\*reviewer\*\*: 职责=code_review, doc_quality, ux_evaluation 禁止=无' && echo true || echo false)"

    # pm/debate 无 responsibilities，不应出现
    assert "不含 pm（无 responsibilities，正确排除）" \
           "$(printf '%s' "$out" | grep -q '\*\*pm\*\*' && echo false || echo true)"

    # 旧实现的垃圾行消失
    assert "旧垃圾行 **forbidden**: 职责=无 消失" \
           "$(printf '%s' "$out" | grep -q '\*\*forbidden\*\*' && echo false || echo true)"
}

# ============================================================
# F2: 集成 — 跑完整 session-start.sh，断言 rules 三段
# ============================================================
test_f2_integration() {
    echo "=== F2: 集成 — 完整 session-start.sh rules 三段 ==="

    local tmp_mem; tmp_mem="$(mktemp -d)"
    CLEANUP_DIRS="${CLEANUP_DIRS} ${tmp_mem}"

    # HARNESS_PROJECTS_DIR 指向临时目录，避免记忆同步产生真实副作用
    local out rc
    out=$(CLAUDE_PROJECT_DIR="$PROJECT_ROOT" HARNESS_PROJECTS_DIR="$tmp_mem" \
          bash "$SESSION_START" 2>/dev/null) && rc=0 || rc=$?
    assert "session-start.sh 退出码 0" "$([ "$rc" = "0" ] && echo true || echo false)"

    # ── roles 段（修正后）──
    assert "集成输出含 architect 角色行" \
           "$(echo "$out" | grep -q '\*\*architect\*\*: 职责=system_design' && echo true || echo false)"
    assert "集成输出含 4 个角色行" \
           "$([ "$(echo "$out" | grep -c '\*\*[a-z_]\+\*\*: 职责=')" = "4" ] && echo true || echo false)"

    # ── QG 段（应与原实现 byte 等价，代码未动）──
    assert "QG-ARCH-001 行存在" \
           "$(echo "$out" | grep -q 'QG-ARCH-001: topology + interface + selection + tech_spec' && echo true || echo false)"
    assert "QG-DEV-001 行存在" \
           "$(echo "$out" | grep -q 'QG-DEV-001: coverage >= 80% (configurable, CI default 60%) + linter zero error' && echo true || echo false)"
    assert "QG-REV-001 行存在" \
           "$(echo "$out" | grep -q 'QG-REV-001: ref scoring.thresholds (authoritative)' && echo true || echo false)"
    assert "QG-REV-002 行存在" \
           "$(echo "$out" | grep -q 'QG-REV-002: 0 (P0 = veto)' && echo true || echo false)"

    # ── Scoring 段（应与原实现 byte 等价，代码未动）──
    assert "Scoring: score >= 90 → direct pass" \
           "$(echo "$out" | grep -q 'score >= 90 → direct pass, submit to PM' && echo true || echo false)"
    assert "Scoring: 75 <= score < 80 → debate required" \
           "$(echo "$out" | grep -q '75 <= score < 80 → debate required' && echo true || echo false)"
    assert "Scoring: score < 75 → direct rework" \
           "$(echo "$out" | grep -q 'score < 75 → direct rework, no debate' && echo true || echo false)"

    # ── 结构标记 ──
    assert "含 ## 质量门禁 段标记" \
           "$(echo "$out" | grep -q '^## 质量门禁' && echo true || echo false)"
    assert "含 ## 评审标准 段标记" \
           "$(echo "$out" | grep -q '^## 评审标准' && echo true || echo false)"

    # ── F3: 垃圾行消失 ──
    assert "集成输出不含旧垃圾行 **forbidden**: 职责=无" \
           "$(echo "$out" | grep -q '\*\*forbidden\*\*: 职责=无' && echo false || echo true)"
}

# ============================================================
# 主入口
# ============================================================
CLEANUP_DIRS=""
cleanup() {
    for d in ${CLEANUP_DIRS}; do
        rm -rf "${d}" 2>/dev/null || true
    done
}
trap cleanup EXIT

echo ""
echo "╔═══════════════════════════════════════════════════════╗"
echo "║  test_session_start_rules_injection.sh               ║"
echo "║  4c awk 重写 + 段2 rm 合并（optimize-session-start） ║"
echo "╚═══════════════════════════════════════════════════════╝"
echo ""

test_s1_syntax
test_s2_optimization_landed
test_f1_awk_unit
test_f2_integration

echo ""
echo "════════════════════════════════════════════════════════"
echo "  Results: $PASS passed, $FAIL failed"
echo "════════════════════════════════════════════════════════"

[ "$FAIL" = "0" ] || exit 1
