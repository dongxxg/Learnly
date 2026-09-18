#!/usr/bin/env bash
# Tests for pre-tool-use-tasks-guard.sh (Issue !163)
#
# 背景：sub-agent 跑 git reset --hard + git clean -fd 组合时，
# clean 会删掉 untracked 的 .harness/tasks/<change>/ 目录，丢失 pipeline-state。
# settings.json 的 deny list 在 defaultMode: bypassPermissions 下可能被绕过，
# 因此加 PreToolUse hook 做更可靠的拦截。
#
# 拦截规则：
#   1) git clean（任何形式：-f / -fd / -fdx / -X 等）
#   2) git reset --hard
#   3) rm -rf 且路径含 .harness/tasks 或 .harness/shared-state
#   4) find + (-delete 或 -exec rm 或 -execdir rm) 且路径含 .harness/tasks
#
# 白名单：.harness/.framework-edit 存在时跳过（PM 授权场景）
#
# 测试用 mktemp -d 隔离 + mock stdin JSON + mock .harness/.framework-edit。
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
HOOK="${REPO_ROOT}/.claude/hooks/shared/pre-tool-use-tasks-guard.sh"
HELPER="${REPO_ROOT}/.claude/hooks/shared/hook-json-helper.sh"

PASS=0
FAIL=0
CLEANUP_DIRS=""

cleanup() {
    for d in ${CLEANUP_DIRS}; do
        rm -rf "${d}"
    done
}
trap cleanup EXIT

if [ ! -f "${HOOK}" ]; then
    echo "FAIL: hook not found at ${HOOK}"
    exit 1
fi

# 工具函数：构造 PreToolUse stdin JSON 并跑 hook
# 用法: run_hook "<command>" "<cwd>"  →  设置 MOCK_CWD 与 stdin，调用 hook
# 输出 hook 的 stdout+stderr 与退出码到全局变量 HOOK_OUT / HOOK_RC
run_hook() {
    local cmd="$1"
    local cwd="${2:-${REPO_ROOT}}"
    # 转义 JSON 字符串中的双引号和反斜杠
    local escaped
    escaped="${cmd//\\/\\\\}"
    escaped="${escaped//\"/\\\"}"
    local payload
    payload='{"tool_name":"Bash","tool_input":{"command":"'${escaped}'"}}'
    # 注意：每次重置 HOOK_RC（避免上次调用残留）
    # HOOK_DENY_EXIT=2 模拟 CodeBuddy/Codex 后端（hook_deny exit 2 表示阻断），
    # Claude 后端默认 exit 0（靠 JSON permissionDecision 拦截），测试需 exit 2 验证拦截。
    HOOK_RC=0
    HOOK_OUT=$(cd "${cwd}" && echo "${payload}" | HOOK_DENY_EXIT=2 bash "${HOOK}" 2>&1) || HOOK_RC=$?
}

# 断言 PASS（hook 不拦截）
assert_pass() {
    local label="$1"
    local cmd="$2"
    run_hook "${cmd}"
    if [ "${HOOK_RC}" -eq 0 ]; then
        echo "  PASS-case [${label}]: PASS"
        PASS=$((PASS + 1))
    else
        echo "  PASS-case [${label}]: FAIL — hook 拦截了无害命令 (rc=${HOOK_RC})"
        echo "    cmd: ${cmd}"
        echo "    out: ${HOOK_OUT}"
        FAIL=$((FAIL + 1))
    fi
}

# 断言 FAIL（hook 拦截）
assert_fail() {
    local label="$1"
    local cmd="$2"
    run_hook "${cmd}"
    if [ "${HOOK_RC}" -ne 0 ]; then
        echo "  FAIL-case [${label}]: PASS (拦截成功)"
        PASS=$((PASS + 1))
    else
        echo "  FAIL-case [${label}]: FAIL — 危险命令未被拦截"
        echo "    cmd: ${cmd}"
        echo "    out: ${HOOK_OUT}"
        FAIL=$((FAIL + 1))
    fi
}

echo "pre-tool-use-tasks-guard.sh tests (Issue !163)"
echo "================================================"

# ─── PASS cases (无害命令) ───
assert_pass "git status"            "git status"
assert_pass "git diff"              "git diff HEAD"
assert_pass "git log"               "git log --oneline -5"
assert_pass "git add"               "git add ."
assert_pass "git commit"            "git commit -m \"test\""
assert_pass "git push"              "git push origin master"
assert_pass "rm -rf /tmp/foo"       "rm -rf /tmp/foo"
assert_pass "find /tmp -delete"     "find /tmp/foo -type f -delete"
assert_pass "bash test.sh"          "bash test.sh"
assert_pass "ls -la"                "ls -la"

# ─── FAIL cases (危险命令) ───
assert_fail "git clean -fd"                "git clean -fd"
assert_fail "git clean -fdx"               "git clean -fdx"
assert_fail "git clean -f"                 "git clean -f"
assert_fail "git clean -X"                 "git clean -X"
assert_fail "git reset --hard HEAD"        "git reset --hard HEAD"
assert_fail "git reset --hard origin/main" "git reset --hard origin/main"
assert_fail "rm -rf .harness/tasks/foo"    "rm -rf .harness/tasks/foo"
assert_fail "rm -rf .harness/shared-state" "rm -rf .harness/shared-state"
assert_fail "find .harness/tasks -delete"  "find .harness/tasks -type f -delete"
assert_fail "find .harness/tasks -exec rm" "find .harness/tasks -type f -exec rm {} \\;"
assert_fail "find .harness/tasks -execdir rm" "find .harness/tasks -type f -execdir rm {} \\;"

# ─── Bypass case (.framework-edit 存在 → 跳过) ───
echo "------------------------------------------------"
echo "  Bypass case (.framework-edit 存在 → git clean -fd 不拦截)"
BYPASS_DIR="$(mktemp -d)"
CLEANUP_DIRS="${CLEANUP_DIRS} ${BYPASS_DIR}"
mkdir -p "${BYPASS_DIR}/.harness"
touch "${BYPASS_DIR}/.harness/.framework-edit"
# hook 检测 .framework-edit 是相对当前目录的，所以 cwd 必须设到 BYPASS_DIR
run_hook "git clean -fd" "${BYPASS_DIR}"
if [ "${HOOK_RC}" -eq 0 ]; then
    echo "  Bypass-case [.framework-edit + git clean -fd]: PASS"
    PASS=$((PASS + 1))
else
    echo "  Bypass-case [.framework-edit + git clean -fd]: FAIL — bypass 场景被误拦"
    echo "    out: ${HOOK_OUT}"
    FAIL=$((FAIL + 1))
fi

echo "================================================"
echo "Results: ${PASS} passed, ${FAIL} failed"
if [ "${FAIL}" -gt 0 ]; then
    exit 1
fi
exit 0
