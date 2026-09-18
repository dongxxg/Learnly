#!/usr/bin/env bash
# Tests for pre-commit TDD pure-deletion exemption
#
# 背景：TDD 检查只看文件清单不看变更内容——纯删除重构（文件保留、只删行）
# 与新增功能同罪被拦。TDD 针对新行为；纯删除不引入新行为，存量测试仍覆盖。
#
# 豁免规则（pre-commit 第 114-122 行附近）：
#   staged 生产代码经同款过滤链后 numstat 新增行总数为 0 → 放行
#   （输出 "[TDD] 纯删除变更，存量测试仍有效"）
# 覆盖：
#   1. 纯删除（只删行）无测试 → 放行
#   2. 删多行+加少量行（净删除但有新增）→ 仍拦（有新行为）
#   3. 新增文件无测试 → 仍拦（回归）
#   4. 新增文件+带测试 → 放行（回归）
#   5. 纯删除 + 测试文件并存 → 放行
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
HOOK="${REPO_ROOT}/.claude/hooks/git/pre-commit"

PASS=0; FAIL=0

[ -f "${HOOK}" ] || { echo "FAIL: hook not found"; exit 1; }

SBOX="$(mktemp -d)"
trap 'rm -rf "${SBOX}"' EXIT

new_repo() {
    rm -rf "${SBOX}/repo"
    mkdir -p "${SBOX}/repo"
    cd "${SBOX}/repo"
    git init -q .
    git config user.email t@t; git config user.name t
    # 挂载被测 hook
    mkdir -p .git/hooks
    cp "${HOOK}" .git/hooks/pre-commit
    chmod +x .git/hooks/pre-commit
    # 基线 commit：带测试文件过 TDD 检查（测试构造，非被测行为）
    printf 'l1\nl2\nl3\nl4\nl5\n' > mod.py
    echo t > test_mod.py
    git add mod.py test_mod.py
    git commit -qm baseline
}

assert_block() { # 期望被拦 (exit 1)
    local label="$1"
    if git commit -qm "wip" 2>"${SBOX}/err"; then
        echo "  FAIL-case [${label}]: FAIL — 应被拦截却提交成功"; FAIL=$((FAIL+1))
    else
        echo "  FAIL-case [${label}]: PASS (拦截成功)"; PASS=$((PASS+1))
    fi
}
assert_pass() { # 期望放行 (commit 成功)
    local label="$1"
    if git commit -qm "wip" 2>"${SBOX}/err"; then
        echo "  PASS-case [${label}]: PASS"; PASS=$((PASS+1))
    else
        echo "  PASS-case [${label}]: FAIL — 应放行却被拦"
        sed 's/^/    /' "${SBOX}/err" | head -5
        FAIL=$((FAIL+1))
    fi
}

echo "── 1. 纯删除（只删行）无测试 → 放行"
new_repo
printf 'l1\nl2\n' > mod.py && git add mod.py   # 3 行删除，0 新增
assert_pass "纯删除豁免"

echo "── 2. 删多加少（有新增行）→ 仍拦"
new_repo
printf 'l1\nnew\n' > mod.py && git add mod.py  # 3 删 1 增
assert_block "有新增行仍拦"

echo "── 3. 新增文件无测试 → 仍拦（回归）"
new_repo
echo x > added.py && git add added.py
assert_block "新增文件无测试"

echo "── 4. 新增文件+带测试 → 放行（回归）"
new_repo
echo x > added.py && echo t > test_added.py && git add added.py test_added.py
assert_pass "新增+测试放行"

echo "── 5. 纯删除 + 测试并存 → 放行"
new_repo
printf 'l1\n' > mod.py && echo t > test_mod.py && git add mod.py test_mod.py
assert_pass "纯删除+测试"

echo ""
echo "=================================================="
echo "RESULT: PASS=${PASS} FAIL=${FAIL}"
echo "=================================================="
[ "${FAIL}" -eq 0 ]
