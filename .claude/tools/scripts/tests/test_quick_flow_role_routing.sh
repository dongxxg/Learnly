#!/usr/bin/env bash
# Tests for quick flow dispatch phase role routing (Issue !162)
#
# 背景：quick flow 的 dispatch/verify/complete phase 在 harness-rules.yaml
# 中 role=null（设计意图：intent-based 路由）。但 advanceImpl/getRole 返回
# null 后，dispatch-prompt 用 null 找不到 agent 报错。
#
# 修复：advance.js 新增 resolveQuickFlowRole(state, phase)，根据
# state.intent.intent_category 路由到正确的 role：
#   bug_fix       → developer
#   code_review   → reviewer
#   testing       → tester
#   explore_design → architect
#   quick_change:
#     affected_files >= 3 → developer
#     affected_files <= 2 → null（主会话自处理）
#   未知 → null（保守让 PM 介入）
#
# 仅对 quick flow + dispatch phase 生效；development flow / 非 dispatch phase
# 返回 null。
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ADVANCE_JS="${SCRIPT_DIR}/../../../skills/rd-auto/scripts/lib/advance.js"

if [ ! -f "${ADVANCE_JS}" ]; then
    echo "SKIP: advance.js not found at ${ADVANCE_JS}"
    exit 0
fi

PASS=0
FAIL=0

# Helper: 调用 resolveQuickFlowRole 并断言返回值
# Usage: assert_role "<state_json>" "<phase>" "<expected_role_or_null>" "<case_name>"
assert_role() {
    local state_json="$1"
    local phase="$2"
    local expected="$3"
    local name="$4"

    local actual
    actual=$(node -e "
        import('${ADVANCE_JS}').then(m => {
            const state = JSON.parse(process.argv[1]);
            const r = m.resolveQuickFlowRole(state, process.argv[2]);
            console.log(r === null ? 'null' : r);
        });
    " "${state_json}" "${phase}" 2>&1) || true

    if [ "${actual}" = "${expected}" ]; then
        echo "  ${name}: PASS"
        PASS=$((PASS + 1))
    else
        echo "  ${name}: FAIL — expected '${expected}', got '${actual}'"
        FAIL=$((FAIL + 1))
    fi
}

echo "quick flow role routing tests (Issue !162)"
echo "==========================================="

# ─── 6 main scenarios: quick flow + dispatch + various intent_category ───

# case 1: bug_fix + dispatch → 'developer'
assert_role '{"flow_type":"quick","intent":{"intent_category":"bug_fix"}}' \
    'dispatch' 'developer' \
    'case 1 (bug_fix + dispatch → developer)'

# case 2: code_review + dispatch → 'reviewer'
assert_role '{"flow_type":"quick","intent":{"intent_category":"code_review"}}' \
    'dispatch' 'reviewer' \
    'case 2 (code_review + dispatch → reviewer)'

# case 3: testing + dispatch → 'tester'
assert_role '{"flow_type":"quick","intent":{"intent_category":"testing"}}' \
    'dispatch' 'tester' \
    'case 3 (testing + dispatch → tester)'

# case 4: explore_design + dispatch → 'architect'
assert_role '{"flow_type":"quick","intent":{"intent_category":"explore_design"}}' \
    'dispatch' 'architect' \
    'case 4 (explore_design + dispatch → architect)'

# case 5: quick_change(3 文件) + dispatch → 'developer'
assert_role '{"flow_type":"quick","intent":{"intent_category":"quick_change","affected_files":["a.py","b.py","c.py"]}}' \
    'dispatch' 'developer' \
    'case 5 (quick_change + 3 files + dispatch → developer)'

# case 6: quick_change(2 文件) + dispatch → null（主会话自处理）
assert_role '{"flow_type":"quick","intent":{"intent_category":"quick_change","affected_files":["a.py","b.py"]}}' \
    'dispatch' 'null' \
    'case 6 (quick_change + 2 files + dispatch → null, main session handles)'

# ─── Regression coverage ───

# case 7: development flow + dispatch → null（不应用 quick flow 路由）
assert_role '{"flow_type":"development","intent":{"intent_category":"bug_fix"}}' \
    'dispatch' 'null' \
    'case 7 (development flow + dispatch → null, no quick routing)'

# case 8: quick flow + 非 dispatch phase（如 verify）→ null
assert_role '{"flow_type":"quick","intent":{"intent_category":"bug_fix"}}' \
    'verify' 'null' \
    'case 8 (quick flow + verify phase → null, only dispatch routed)'

# case 9: quick flow + complete phase → null
assert_role '{"flow_type":"quick","intent":{"intent_category":"bug_fix"}}' \
    'complete' 'null' \
    'case 9 (quick flow + complete phase → null)'

# case 10: 未知 intent_category → null（保守让 PM 介入）
assert_role '{"flow_type":"quick","intent":{"intent_category":"unknown_category"}}' \
    'dispatch' 'null' \
    'case 10 (unknown intent_category → null, PM handles)'

# case 11: quick_change 无 affected_files 字段 → null（保守）
assert_role '{"flow_type":"quick","intent":{"intent_category":"quick_change"}}' \
    'dispatch' 'null' \
    'case 11 (quick_change no affected_files → null)'

# case 12: state.intent 整个缺失 → null
assert_role '{"flow_type":"quick"}' \
    'dispatch' 'null' \
    'case 12 (no intent field → null)'

# case 13: quick_change 恰好 3 文件 → developer（边界）
assert_role '{"flow_type":"quick","intent":{"intent_category":"quick_change","affected_files":["x","y","z"]}}' \
    'dispatch' 'developer' \
    'case 13 (quick_change exactly 3 files → developer, boundary)'

# case 14: quick_change 1 文件 → null
assert_role '{"flow_type":"quick","intent":{"intent_category":"quick_change","affected_files":["only.py"]}}' \
    'dispatch' 'null' \
    'case 14 (quick_change 1 file → null)'

# case 15: hotfix flow + dispatch → null（hotfix 不是 quick flow）
assert_role '{"flow_type":"hotfix","intent":{"intent_category":"bug_fix"}}' \
    'dispatch' 'null' \
    'case 15 (hotfix flow + dispatch → null)'

echo "==========================================="
echo "Results: ${PASS} passed, ${FAIL} failed"
if [ "${FAIL}" -gt 0 ]; then
    exit 1
fi
exit 0
