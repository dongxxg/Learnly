#!/usr/bin/env bash
# Functional tests for pre-receive merge-commit branch-allowlist guard
#
# 验证 pre-receive hook 按 refname 白名单拦截违规本地 merge commit：
#   - 白名单分支（main/master/release/*）放行 merge commit（合法 MR 合并落点）
#   - release-* 横线命名发布分支同 release/* 待遇（merge 放行 + 格式豁免）
#   - 非白名单分支（feature/个人分支）拒绝 merge commit，提示走 GitLab MR
#   - 普通 1-parent commit 行为不变（合法放行 / 非法 msg 仍被原逻辑拒绝）
#   - 环境变量 PRECEIVE_MERGE_ALLOW_REFS 可配置白名单（覆盖默认）
#   - tag/其它 ref 保守拒绝 merge
#
# 测试策略：临时仓库构造真实 commit（含 merge commit），通过 stdin 喂
# oldrev/newrev/refname 模拟 push，断言退出码 + 输出。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOOK="${SCRIPT_DIR}/../../../hooks/git/pre-receive"
PASS=0
FAIL=0

[ -f "${HOOK}" ] || { echo "SKIP: pre-receive hook not found at ${HOOK}"; exit 1; }

WORK_REPO="$(mktemp -d)"
cleanup() { rm -rf "${WORK_REPO}"; }
trap cleanup EXIT

# 合法 commit message（通过 AI Git 提交规范全部 6 条规则）
ok_msg() { printf '[0] DEV %s[AI-wangzk.Developer]\n\nfeat: %s\n- 变更' "$1" "$2"; }

# ---- 构造 commit objects（在子 shell 里执行 git，结果落盘供父 shell 读取）----
(
    cd "${WORK_REPO}"
    git init --quiet
    git config user.name "wangzk"
    git config user.email "wangzk@test.com"
    git config commit.gpgsign false

    # C0 基线（合法 msg）
    git commit --allow-empty --quiet -m "$(ok_msg init baseline)"
    C0=$(git rev-parse HEAD); echo "${C0}" > "${WORK_REPO}/.c0"

    # merge commit：从 C0 开 tmp 加一个 commit，再在 mergebase 分支 merge --no-ff
    git checkout -q -b tmp "${C0}"
    git commit --allow-empty --quiet -m "$(ok_msg feature tmp-work)"
    git checkout -q -b mergebase "${C0}"
    git merge --no-ff --quiet tmp -m "Merge tmp"
    echo "$(git rev-parse HEAD) $(git rev-parse HEAD^1)" > "${WORK_REPO}/.mergeinfo"

    # 普通合法 commit（1-parent，msg 合法）
    git checkout -q -b plainbr "${C0}"
    git commit --allow-empty --quiet -m "$(ok_msg plain plain-work)"
    git rev-parse HEAD > "${WORK_REPO}/.plaininfo"

    # 普通非法 msg commit（1-parent，msg 不符规范，验证原 msg 校验逻辑不变）
    git checkout -q -b badbr "${C0}"
    git commit --allow-empty --quiet -m "bad message no spec format"
    git rev-parse HEAD > "${WORK_REPO}/.badinfo"
)
MERGE_SHA=$(cut   -d' ' -f1 "${WORK_REPO}/.mergeinfo")
MERGE_PARENT=$(cut -d' ' -f2 "${WORK_REPO}/.mergeinfo")
PLAIN_SHA=$(cat "${WORK_REPO}/.plaininfo")
BAD_SHA=$(cat   "${WORK_REPO}/.badinfo")
PLAIN_PARENT=$(cat "${WORK_REPO}/.c0")
BAD_PARENT=$(cat   "${WORK_REPO}/.c0")

# run <name> <expected_exit> <assert_contains|> <oldrev> <newrev> <refname> [env_kv...]
run() {
    local name="$1" expected="$2" assert="$3"
    local oldrev="$4" newrev="$5" refname="$6"
    shift 6
    local actual=0 out
    out=$(cd "${WORK_REPO}" && printf '%s %s %s\n' "$oldrev" "$newrev" "$refname" \
          | env "$@" bash "${HOOK}" 2>&1) || actual=$?
    echo -n "  ${name}: "
    if [ "${actual}" -ne "${expected}" ]; then
        echo "FAIL (expected exit=${expected}, got exit=${actual})"
        echo "${out}" | sed 's/^/    /'
        FAIL=$((FAIL + 1)); return
    fi
    if [ -n "${assert}" ] && ! printf '%s' "${out}" | grep -qF -- "${assert}"; then
        echo "FAIL (output missing required hint: ${assert})"
        echo "${out}" | sed 's/^/    /'
        FAIL=$((FAIL + 1)); return
    fi
    echo "PASS"
    PASS=$((PASS + 1))
}

echo "pre-receive merge-commit guard Functional Tests"
echo "================================================"

# === 白名单分支放行 merge commit（合法 MR 合并落点）===
run "白名单 main + merge commit → 放行"         0 "" "${MERGE_PARENT}" "${MERGE_SHA}" "refs/heads/main"
run "白名单 master + merge commit → 放行"       0 "" "${MERGE_PARENT}" "${MERGE_SHA}" "refs/heads/master"
run "白名单 release/1.0 + merge commit → 放行"  0 "" "${MERGE_PARENT}" "${MERGE_SHA}" "refs/heads/release/1.0"
run "白名单 release-1.0 + merge commit → 放行(横线命名)"  0 "" "${MERGE_PARENT}" "${MERGE_SHA}" "refs/heads/release-1.0"

# === 非白名单分支拒绝 merge commit（违规本地 merge）===
run "非白名单 feature/xyz + merge → 拒绝(MR提示)"  1 "Merge Request" "${MERGE_PARENT}" "${MERGE_SHA}" "refs/heads/feature/xyz"
run "非白名单 dev/xxx + merge → 拒绝(白名单提示)"  1 "merge 白名单"   "${MERGE_PARENT}" "${MERGE_SHA}" "refs/heads/dev/xxx"

# === 普通 1-parent commit 行为不变 ===
run "非白名单 feature + 普通合法 commit → 放行"  0 "" "${PLAIN_PARENT}" "${PLAIN_SHA}" "refs/heads/feature/xyz"
run "普通 commit msg 不规范 → 原逻辑拒绝"        1 "不符合" "${BAD_PARENT}" "${BAD_SHA}" "refs/heads/feature/xyz"

# === dev/develop 纳入格式校验：普通 commit 校验格式，merge commit 仍放行 ===
run "develop + 普通合法 commit → 放行(格式校验通过)" 0 "" "${PLAIN_PARENT}" "${PLAIN_SHA}" "refs/heads/develop"
run "develop + 普通非法 msg → 拒绝(格式校验生效)"   1 "不符合" "${BAD_PARENT}" "${BAD_SHA}" "refs/heads/develop"
run "develop + merge commit → 放行(MR 合法落点)"    0 "" "${MERGE_PARENT}" "${MERGE_SHA}" "refs/heads/develop"
run "dev + 普通非法 msg → 拒绝(格式校验生效)"       1 "不符合" "${BAD_PARENT}" "${BAD_SHA}" "refs/heads/dev"
run "dev + merge commit → 放行(MR 合法落点)"        0 "" "${MERGE_PARENT}" "${MERGE_SHA}" "refs/heads/dev"

# === main/master/release/* 仍豁免格式校验（历史遗留受保护分支行为不变）===
run "main + 普通非法 msg → 放行(仍豁免格式校验)"     0 "" "${BAD_PARENT}" "${BAD_SHA}" "refs/heads/main"
run "release/1.0 + 普通非法 msg → 放行(仍豁免)"      0 "" "${BAD_PARENT}" "${BAD_SHA}" "refs/heads/release/1.0"
run "release-1.0 + 普通非法 msg → 放行(横线命名仍豁免)"  0 "" "${BAD_PARENT}" "${BAD_SHA}" "refs/heads/release-1.0"

# === 环境变量 PRECEIVE_FORMAT_SKIP_REFS 可把 develop 重新豁免（覆盖默认）===
run "配置 FORMAT_SKIP=develop → develop 非法 msg 放行" 0 "" "${BAD_PARENT}" "${BAD_SHA}" "refs/heads/develop" "PRECEIVE_FORMAT_SKIP_REFS=develop"

# === tag / 其它 ref 保守拒绝 merge ===
run "tag ref + merge → 保守拒绝"                 1 "禁止本地 merge" "${MERGE_PARENT}" "${MERGE_SHA}" "refs/tags/v1.0"

# === 环境变量 PRECEIVE_MERGE_ALLOW_REFS 配置生效（覆盖默认）===
run "配置 feature/* → feature merge 放行"        0 "" "${MERGE_PARENT}" "${MERGE_SHA}" "refs/heads/feature/xyz" "PRECEIVE_MERGE_ALLOW_REFS=feature/*"
run "配置 dev/* → main merge 反而被拒(默认被覆盖)" 1 "禁止本地 merge" "${MERGE_PARENT}" "${MERGE_SHA}" "refs/heads/main" "PRECEIVE_MERGE_ALLOW_REFS=dev/*"

# === 边界：配置极端值不能让 hook 崩溃（hook 崩溃会拒绝所有 push）===
run "空配置 '' → :- 回退默认值，main 仍放行"                0 "" "${MERGE_PARENT}" "${MERGE_SHA}" "refs/heads/main" "PRECEIVE_MERGE_ALLOW_REFS="
run "异常配置 ',' → 空数组拒绝所有 merge 且不崩"           1 "禁止本地 merge" "${MERGE_PARENT}" "${MERGE_SHA}" "refs/heads/main" "PRECEIVE_MERGE_ALLOW_REFS=,"
run "带空白 'main, master' → trim 生效后 main 放行"        0 "" "${MERGE_PARENT}" "${MERGE_SHA}" "refs/heads/main" "PRECEIVE_MERGE_ALLOW_REFS=main, master"

echo "================================================"
echo "Results: ${PASS} passed, ${FAIL} failed"
[ "${FAIL}" -gt 0 ] && exit 1
exit 0
