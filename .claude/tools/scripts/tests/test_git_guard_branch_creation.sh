#!/usr/bin/env bash
# Tests for pre-tool-use-git-guard.sh branch creation guard
#
# 背景：AI 自作主张随意创建分支（存量见 verify/bpc、worktree-agent-*、纯数字、
# dev 等）。分支命名规范仅文档级，无强制力。
#
# 治理策略（PM 确认）：校验 + PM 审批（Challenge-Response）
#   - 分支名不合规 → 直接拦截（不走审批）
#   - 分支名合规 → 生成挑战码（绑定分支名），PM 批准后放行
#   - 切换/删除已有分支不拦截
#
# 拦截规则（pre-tool-use-git-guard.sh 第 4 段）：
#   - checkout -b/-B、switch -c/-C、branch <name>、worktree add -b
#   - branch 后跟 flag（-d/-a/-m/...）→ 非创建，放行
#   - CLAUDE_BRANCH_AUTO_APPROVE=1 → 豁免
#
# 状态机用例通过在临时目录伪造 .harness/.branch-challenge/.branch-approved 覆盖。
# 参考：test_git_guard_pull_rebase.sh 的 run_hook/assert_pass/assert_fail 风格。
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

# 测试沙箱：CLAUDE_PROJECT_DIR 指向这里，挑战码/token 文件落在此处
TEST_DIR="$(mktemp -d)"
trap 'rm -rf "${TEST_DIR}"' EXIT
mkdir -p "${TEST_DIR}/.harness"

run_hook() {
    local cmd="$1"
    local escaped="${cmd//\\/\\\\}"
    escaped="${escaped//\"/\\\"}"
    local payload='{"tool_name":"Bash","tool_input":{"command":"'${escaped}'"}}'
    HOOK_RC=0
    HOOK_OUT=$(echo "${payload}" | HOOK_DENY_EXIT=2 CLAUDE_PROJECT_DIR="${TEST_DIR}" \
        bash "${HOOK}" 2>&1) || HOOK_RC=$?
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
        echo "  FAIL-case [${label}]: FAIL — 建分支命令未被拦截"
        echo "    cmd: ${cmd}"
        FAIL=$((FAIL + 1))
    fi
}

reset_state() {
    rm -f "${TEST_DIR}/.harness/.branch-challenge" "${TEST_DIR}/.harness/.branch-approved"
}

# ── 1. 分支名合规校验（不合规直接拦，无审批通道）──
reset_state
assert_fail "无type前缀-dev"        "git checkout -b dev" "不符合命名规范"
assert_fail "无type前缀-纯数字"     "git checkout -b 630" "不符合命名规范"
assert_fail "type不在白名单"        "git checkout -b verify/bpc" "不符合命名规范"
assert_fail "大写"                  "git checkout -b Feature/630" "不符合命名规范"
assert_fail "下划线"                "git checkout -b feature/630_x" "不符合命名规范"
assert_fail "个人姓名前缀"          "git checkout -b zhangsan/feature-630" "不符合命名规范"
assert_fail "worktree-不合规名"     "git worktree add -b worktree-agent-xxx /tmp/wtx" "不符合命名规范"

# ── 2. 合规名 → 挑战码生成 ──
reset_state
assert_fail "合规名首次触发"        "git checkout -b feature/630" "挑战码"
[ -f "${TEST_DIR}/.harness/.branch-challenge" ] \
    && { echo "  PASS-case [挑战码文件已生成]: PASS"; PASS=$((PASS+1)); } \
    || { echo "  FAIL-case [挑战码文件已生成]: FAIL"; FAIL=$((FAIL+1)); }

# ── 3. 状态机：token 校验 ──
reset_state
NONCE="deadbeef"
printf '%s:feature/630:%s\n' "${NONCE}" "$(date +%s)" > "${TEST_DIR}/.harness/.branch-challenge"
echo "wrongtoken" > "${TEST_DIR}/.harness/.branch-approved"
assert_fail "错误token"            "git checkout -b feature/630" "令牌无效"
[ ! -f "${TEST_DIR}/.harness/.branch-approved" ] \
    && { echo "  PASS-case [错误token已清理]: PASS"; PASS=$((PASS+1)); } \
    || { echo "  FAIL-case [错误token已清理]: FAIL"; FAIL=$((FAIL+1)); }

reset_state
printf '%s:feature/630:%s\n' "${NONCE}" "$(date +%s)" > "${TEST_DIR}/.harness/.branch-challenge"
assert_fail "有效挑战码+无token"    "git checkout -b feature/630" "等待批准"

reset_state
printf '%s:fix/999:%s\n' "${NONCE}" "$(date +%s)" > "${TEST_DIR}/.harness/.branch-challenge"
echo "${NONCE}" > "${TEST_DIR}/.harness/.branch-approved"
assert_fail "token对但分支名不同"   "git checkout -b feature/777" "分支名不一致"

reset_state
echo "${NONCE}" > "${TEST_DIR}/.harness/.branch-approved"
assert_fail "残留token无挑战码"     "git checkout -b feature/630" "无对应挑战码"

# 正确 token + 同分支名 → 放行 + 清理（核心放行路径）
reset_state
printf '%s:feature/630:%s\n' "${NONCE}" "$(date +%s)" > "${TEST_DIR}/.harness/.branch-challenge"
echo "${NONCE}" > "${TEST_DIR}/.harness/.branch-approved"
assert_pass "正确token放行"         "git checkout -b feature/630"
[ ! -f "${TEST_DIR}/.harness/.branch-challenge" ] && [ ! -f "${TEST_DIR}/.harness/.branch-approved" ] \
    && { echo "  PASS-case [放行后状态文件清理]: PASS"; PASS=$((PASS+1)); } \
    || { echo "  FAIL-case [放行后状态文件清理]: FAIL"; FAIL=$((FAIL+1)); }

# 过期挑战码（伪造旧 mtime）→ 拒 + 清理
reset_state
printf '%s:feature/630:%s\n' "${NONCE}" "$(( $(date +%s) - 600 ))" > "${TEST_DIR}/.harness/.branch-challenge"
echo "${NONCE}" > "${TEST_DIR}/.harness/.branch-approved"
touch -d "10 minutes ago" "${TEST_DIR}/.harness/.branch-challenge" 2>/dev/null || touch -t "$(date -d '-10 minutes' +%Y%m%d%H%M 2>/dev/null || date -v-10M +%Y%m%d%H%M 2>/dev/null || echo 202001010000)" "${TEST_DIR}/.harness/.branch-challenge"
assert_fail "过期挑战码"            "git checkout -b feature/630" "过期"
[ ! -f "${TEST_DIR}/.harness/.branch-challenge" ] && [ ! -f "${TEST_DIR}/.harness/.branch-approved" ] \
    && { echo "  PASS-case [过期后状态文件清理]: PASS"; PASS=$((PASS+1)); } \
    || { echo "  FAIL-case [过期后状态文件清理]: FAIL"; FAIL=$((FAIL+1)); }

# ── 4. 拦截范围：创建命令形态 ──
reset_state
assert_fail "checkout -B"           "git checkout -B feature/630" "挑战码"
reset_state
assert_fail "switch -c"             "git switch -c fix/152-render-bug" "挑战码"
reset_state
assert_fail "switch -C"             "git switch -C feature/630" "挑战码"
reset_state
assert_fail "branch 创建"           "git branch chore/bump-deps" "挑战码"
reset_state
assert_fail "branch 带 start-point" "git branch feature/999 origin/main" "挑战码"
reset_state
assert_fail "worktree add -b 合规名" "git worktree add -b feature/999 /tmp/wtx" "挑战码"

# ── 5. 放行回归：非创建操作 ──
reset_state
assert_pass "切换已有分支"          "git checkout feature/830"
assert_pass "switch已有分支"        "git switch feature/830"
assert_pass "列分支"                "git branch"
assert_pass "列分支-a"              "git branch -a"
assert_pass "删分支-D"              "git branch -D feature/999"
assert_pass "branch -m 重命名(明确不拦)" "git branch -m feature/old feature/new"
assert_pass "读当前分支名"          "git branch --show-current"
assert_pass "git status"            "git status -sb"

# ── 6. CI 豁免 ──
reset_state
PAYLOAD='{"tool_name":"Bash","tool_input":{"command":"git checkout -b whatever-name"}}'
HOOK_RC=0
HOOK_OUT=$(echo "${PAYLOAD}" | HOOK_DENY_EXIT=2 CLAUDE_PROJECT_DIR="${TEST_DIR}" \
    CLAUDE_BRANCH_AUTO_APPROVE=1 bash "${HOOK}" 2>&1) || HOOK_RC=$?
if [ "${HOOK_RC}" -eq 0 ]; then
    echo "  PASS-case [CI豁免]: PASS"; PASS=$((PASS+1))
else
    echo "  FAIL-case [CI豁免]: FAIL — AUTO_APPROVE 未生效"
    echo "    out: ${HOOK_OUT}"
    FAIL=$((FAIL+1))
fi

echo ""
echo "=================================================="
echo "RESULT: PASS=${PASS} FAIL=${FAIL}"
echo "=================================================="
[ "${FAIL}" -eq 0 ]
