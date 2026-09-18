#!/usr/bin/env bash
# Functional tests for commit-msg hook (Issue !154)
#
# 验证 commit-msg hook 与 .claude/rules/ai-git-commit-spec.md 一致：
#   - 3 种合法操作者格式（[AI-{user}.{role}] / [AI·{role}] / [H-{user}]）
#   - 任务号必填（无任务用 [0]）
#   - 字母前缀任务号（abc-123）合法
#   - 错误提示含 3 种合法示例
#   - 模块名黑名单
#   - ci 类型禁止 AI 独立提交
#   - 操作者用户名必须匹配 git config user.name
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOOK="${SCRIPT_DIR}/../../../hooks/git/commit-msg"
PASS=0
FAIL=0

if [ ! -f "${HOOK}" ]; then
    echo "SKIP: commit-msg hook not found at ${HOOK}"
    exit 1
fi

# 在临时 git 仓库中执行，便于隔离 git config user.name
WORK_REPO="$(mktemp -d)"
CLEANUP_DIRS="${WORK_REPO}"
cleanup() {
    for d in ${CLEANUP_DIRS}; do
        rm -rf "${d}"
    done
}
trap cleanup EXIT

(
    cd "${WORK_REPO}"
    git init --quiet
    git config user.name "wangzk"
    git config user.email "wangzk@test.com"
)

# run_case <name> <expected_exit> <assert_stderr_contains|> <message>
# expected_exit: 0 = hook 接受, 非 0 = hook 拒绝
# assert_stderr_contains: 非空时，要求 stderr 含该子串（用于验证错误提示质量）
run_case() {
    local name="$1"
    local expected_exit="$2"
    local assert_contains="$3"
    local message="$4"

    local tmp_msg="$(mktemp)"
    CLEANUP_DIRS="${CLEANUP_DIRS} ${tmp_msg}"
    printf '%s' "${message}" > "${tmp_msg}"

    local actual_exit=0
    local stderr_out
    stderr_out=$(cd "${WORK_REPO}" && bash "${HOOK}" "${tmp_msg}" 2>&1 >/dev/null) || actual_exit=$?

    echo -n "  ${name}: "
    if [ "${actual_exit}" -ne "${expected_exit}" ]; then
        echo "FAIL (expected exit=${expected_exit}, got exit=${actual_exit})"
        echo "    ---- stderr ----"
        echo "${stderr_out}" | sed 's/^/    /'
        FAIL=$((FAIL + 1))
        return
    fi
    if [ -n "${assert_contains}" ]; then
        # expected_exit 必为非 0 时才检查 stderr 内容
        if ! printf '%s' "${stderr_out}" | grep -qF -- "${assert_contains}"; then
            echo "FAIL (stderr missing required hint)"
            echo "    expected to contain: ${assert_contains}"
            echo "    ---- actual stderr ----"
            echo "${stderr_out}" | sed 's/^/    /'
            FAIL=$((FAIL + 1))
            return
        fi
    fi
    echo "PASS"
    PASS=$((PASS + 1))
}

# 构造完整 message（首行 + 空行 + body）
mk_msg() {
    local header="$1"
    local type="${2:-feat}"
    printf '%s\n\n%s: 中文摘要\n- 变更点' "${header}" "${type}"
}

echo "commit-msg hook Functional Tests (Issue !154)"
echo "============================================="

# === 合法用例（应通过） ===

run_case "[0] BUG git-guard[AI-wangzk.Developer] (标准有用户名)" \
    0 "" \
    "$(mk_msg '[0] BUG git-guard[AI-wangzk.Developer]' fix)"

run_case "[0] BUG git-guard[AI·Developer] (简写省略用户名)" \
    0 "" \
    "$(mk_msg '[0] BUG git-guard[AI·Developer]' fix)"

run_case "[0] BUG git-guard[H-wangzk] (人类)" \
    0 "" \
    "$(mk_msg '[0] BUG git-guard[H-wangzk]' fix)"

run_case "[abc-123] DEV 融合引擎[AI-wangzk.Developer] (字母前缀任务号)" \
    0 "" \
    "$(mk_msg '[abc-123] DEV 融合引擎[AI-wangzk.Developer]' feat)"

run_case "[PRJ96199-7] DEV E2E验收[AI-wangzk.Developer] (字母数字前缀任务号, 修复 1.25.1 收紧回归)" \
    0 "" \
    "$(mk_msg '[PRJ96199-7] DEV E2E验收[AI-wangzk.Developer]' feat)"

# === 非法用例（应拒绝）===

# 缺任务号 — 关键 issue 场景：错误提示必须含 3 种合法示例
run_case "DEV mysql-backup[AI-wangzk.Developer] (缺任务号，提示含 3 种示例)" \
    1 "[0] BUG git-guard[AI-wangzk.Developer]" \
    "$(mk_msg 'DEV mysql-backup[AI-wangzk.Developer]' fix)"

# 同一错误提示必须也含简写示例（与 hook 实际输出对齐）
run_case "缺任务号 — 提示含简写示例 [AI·{角色}]" \
    1 "[630] DEV 融合引擎[AI·Developer]" \
    "$(mk_msg 'DEV mysql-backup[AI-wangzk.Developer]' fix)"

# 同一错误提示必须也含无任务号示例的说明（任务号必填）
run_case "缺任务号 — 提示含任务号必填说明" \
    1 "任务号必填" \
    "$(mk_msg 'DEV mysql-backup[AI-wangzk.Developer]' fix)"

# 模块名太泛
run_case "[0] DEV 优化[AI-wangzk.Developer] (模块名太泛)" \
    1 "模块名太泛化" \
    "$(mk_msg '[0] DEV 优化[AI-wangzk.Developer]' feat)"

# ci 类型禁止 AI 独立
run_case "[0] CI 融合引擎[AI·Developer] (ci 类型禁止 AI 独立)" \
    1 "ci 类型禁止 AI 独立提交" \
    "$(mk_msg '[0] CI 融合引擎[AI·Developer]' ci)"

# === 用户名不匹配（隔离 git user.name）===
# 临时改 git user.name 为 alice，首行写 bob 应被拒绝
(
    cd "${WORK_REPO}"
    git config user.name "alice"
)

run_case "user.name=alice 但首行 [AI-bob.Developer] (用户名不匹配)" \
    1 "操作者用户名 'bob' 与 git config user.name 'alice' 不一致" \
    "$(mk_msg '[0] DEV fusion-engine[AI-bob.Developer]' feat)"

# 改回 wangzk 后，简写 [AI·Developer] 应通过（不校验用户名）
(
    cd "${WORK_REPO}"
    git config user.name "wangzk"
)

run_case "user.name=wangzk + [AI·Developer] (简写跳过用户名校验)" \
    0 "" \
    "$(mk_msg '[0] BUG git-guard[AI·Developer]' fix)"

echo "============================================="
echo "Results: ${PASS} passed, ${FAIL} failed"
if [ "${FAIL}" -gt 0 ]; then
    exit 1
fi
exit 0
