#!/usr/bin/env bash
# Tests for pre-tool-use-git-guard.sh pull --rebase guard (Issue !730)
#
# 背景：AI 在 feature 分支落后远端时执行裸 `git pull`，git 默认 merge 策略
# → 本地产生 merge commit → 被 server 端 pre-receive 拒（事后拦截，AI 已 push
# 失败需回退返工）。前置防线 4 层中前 3 层全漏：
#   - L1 settings.json deny 只列 git merge，没 git pull
#   - L2 git-guard 正则只拦 `git pull ... main/master`，裸 pull 不匹配
#   - L3 pre-push behind 检查：AI pull 后 behind=0，绕过
# 本测试覆盖 L2 的补强：拦截裸 git pull（无 --rebase）。
#
# 拦截规则（pre-tool-use-git-guard.sh 第 2、2.5 段）：
#   - git pull 含 main/master 且无 --rebase → 拦（现有规则，message 关于"基线分支"）
#   - 任何 git pull 无 --rebase → 拦（新增规则，message 提示用 git pull --rebase）
#   - git pull --rebase（含 git pull --rebase origin main）→ 放行
#   - git pull --no-rebase → 拦（显式强制 merge）
#   - git merge 仍被原规则拦
#   - git fetch 等非 pull 命令放行
#
# 参考：test_pre_tool_use_tasks_guard.sh 的 run_hook/assert_pass/assert_fail 风格。
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
HOOK="${REPO_ROOT}/.claude/hooks/shared/pre-tool-use-git-guard.sh"

PASS=0
FAIL=0

if [ ! -f "${HOOK}" ]; then
    echo "FAIL: hook not found at ${HOOK}"
    exit 1
fi

# 构造 PreToolUse stdin JSON 并跑 hook
# HOOK_DENY_EXIT=2 让 hook_deny 非零退出，便于 assert_fail 断言（模拟 CodeBuddy/Codex 后端）
run_hook() {
    local cmd="$1"
    local escaped="${cmd//\\/\\\\}"
    escaped="${escaped//\"/\\\"}"
    local payload='{"tool_name":"Bash","tool_input":{"command":"'${escaped}'"}}'
    HOOK_RC=0
    HOOK_OUT=$(echo "${payload}" | HOOK_DENY_EXIT=2 bash "${HOOK}" 2>&1) || HOOK_RC=$?
}

assert_pass() {
    local label="$1" cmd="$2"
    run_hook "${cmd}"
    if [ "${HOOK_RC}" -eq 0 ]; then
        echo "  PASS-case [${label}]: PASS"
        PASS=$((PASS + 1))
    else
        echo "  PASS-case [${label}]: FAIL — hook 拦截了应放行的命令 (rc=${HOOK_RC})"
        echo "    cmd: ${cmd}"
        echo "    out: ${HOOK_OUT}"
        FAIL=$((FAIL + 1))
    fi
}

# assert_fail "<label>" "<cmd>" ["<required_hint>"]
# required_hint 可选：若给，则拦截 message 必须含此子串
assert_fail() {
    local label="$1" cmd="$2" hint="${3:-}"
    run_hook "${cmd}"
    if [ "${HOOK_RC}" -ne 0 ]; then
        if [ -n "${hint}" ] && ! printf '%s' "${HOOK_OUT}" | grep -qF -- "${hint}"; then
            echo "  FAIL-case [${label}]: FAIL — 已拦截但 message 缺少提示 '${hint}'"
            echo "    cmd: ${cmd}"
            echo "    out: ${HOOK_OUT}"
            FAIL=$((FAIL + 1))
            return
        fi
        echo "  FAIL-case [${label}]: PASS (拦截成功)"
        PASS=$((PASS + 1))
    else
        echo "  FAIL-case [${label}]: FAIL — 危险命令未被拦截"
        echo "    cmd: ${cmd}"
        echo "    out: ${HOOK_OUT}"
        FAIL=$((FAIL + 1))
    fi
}

echo "pre-tool-use-git-guard.sh pull --rebase tests (Issue !730)"
echo "================================================"

# === PM 边界 case 表（8 条核心断言）===

# ─── 新增拦截：裸 git pull（无 --rebase）───
assert_fail "裸 git pull"                 "git pull"                         "git pull --rebase"
assert_fail "git pull origin feature"     "git pull origin feature/730"      "git pull --rebase"
assert_fail "git pull --no-rebase"        "git pull --no-rebase"             "git pull --rebase"

# ─── --rebase 放行（含 git pull --rebase origin main）───
assert_pass "git pull --rebase"            "git pull --rebase"
assert_pass "git pull --rebase origin main" "git pull --rebase origin main"

# ─── 现有规则不破坏：pull main/master 无 --rebase 仍拦 ───
assert_fail "git pull main (现有规则)"     "git pull main"
assert_fail "git merge feature (现有规则)" "git merge feature/xyz"

# ─── 非 pull 命令放行 ───
assert_pass "git fetch"                    "git fetch"

# === 补充 case（增强信心，不超出 PM 边界表语义）===

assert_pass "git fetch origin"             "git fetch origin"
assert_fail "git pull origin master"       "git pull origin master"
assert_pass "git pull --rebase origin feature/730"  "git pull --rebase origin feature/730"
# status/diff/log 白名单不受影响
assert_pass "git status -sb"               "git status -sb"
# 带 && 前置的 pull 也要拦（shell 组合命令）
assert_fail "git fetch && git pull"        "git fetch && git pull"

echo "================================================"
echo "Results: ${PASS} passed, ${FAIL} failed"
if [ "${FAIL}" -gt 0 ]; then
    exit 1
fi
exit 0
