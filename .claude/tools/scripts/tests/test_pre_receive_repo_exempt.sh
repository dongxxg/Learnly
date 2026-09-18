#!/usr/bin/env bash
# Functional tests for pre-receive repo-level format-exemption list
#
# 验证 pre-receive hook 的仓库级格式豁免名单（非 Uni-AURI 项目整仓豁免）：
#   - 命中名单（GL_PROJECT_PATH 精确匹配）→ 格式校验全跳过，任意分支放行非法 msg
#   - merge commit 管控不豁免：豁免仓库在非白名单分支 merge 仍被拒绝
#   - 未命中名单（含前缀相似）→ 格式校验照常
#   - 清单缺失/为空 → fail-safe：无豁免，校验照常
#   - # 注释、空行、行首尾空白 → 正确跳过/trim 后匹配
#   - $PWD 推导兜底（GL_PROJECT_PATH 缺失）：repositories/ 相对路径 / 裸 basename
#   - GL_PROJECT_PATH 为主：设置时优先于 $PWD 推导
#
# 测试策略：临时仓库构造真实 commit，通过 stdin 喂 oldrev/newrev/refname 模拟
# push，断言退出码 + 输出。清单文件用 PRECEIVE_EXEMPT_REPOS_FILE 指向临时 txt。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOOK="${SCRIPT_DIR}/../../../hooks/git/pre-receive"
PASS=0
FAIL=0

[ -f "${HOOK}" ] || { echo "SKIP: pre-receive hook not found at ${HOOK}"; exit 1; }

WORK_ROOT="$(mktemp -d)"
WORK_REPO="${WORK_ROOT}/work"
cleanup() { rm -rf "${WORK_ROOT}"; }
trap cleanup EXIT

# 合法 commit message（通过 AI Git 提交规范全部 6 条规则）
ok_msg() { printf '[0] DEV %s[AI-wangzk.Developer]\n\nfeat: %s\n- 变更' "$1" "$2"; }

# mkcommit <repo_dir> <msg_file_content>：在指定目录构造基线+新 commit，
# 输出 "parent sha" 到 <repo_dir>/.pair
mkcommit() {
    local dir="$1" msg="$2"
    (
        cd "${dir}"
        git init --quiet
        git config user.name "wangzk"
        git config user.email "wangzk@test.com"
        git config commit.gpgsign false
        git commit --allow-empty --quiet -m "$(ok_msg init baseline)"
        local parent
        parent=$(git rev-parse HEAD)
        # merge commit：从基线开 tmp 加一个 commit，回基线 merge --no-ff
        git checkout -q -b tmp "${parent}"
        git commit --allow-empty --quiet -m "$(ok_msg feature tmp-work)"
        git checkout -q -b mergebase "${parent}"
        git merge --no-ff --quiet tmp -m "Merge tmp"
        git rev-parse HEAD > "${dir}/.merge_sha"
        # 普通非法 msg commit（1-parent，msg 不符规范）
        git checkout -q -b badbr "${parent}"
        git commit --allow-empty --quiet -m "$msg"
        echo "${parent} $(git rev-parse HEAD)" > "${dir}/.pair"
    )
}

mkdir -p "${WORK_REPO}"
mkcommit "${WORK_REPO}" "bad message no spec format"
BAD_PARENT=$(cut -d' ' -f1 "${WORK_REPO}/.pair")
BAD_SHA=$(cut -d' ' -f2 "${WORK_REPO}/.pair")
MERGE_SHA=$(cat "${WORK_REPO}/.merge_sha")

# $PWD 推导兜底专用仓库：gitaly 存储布局 repositories/grp/proj
NESTED_REPO="${WORK_ROOT}/repositories/grp/proj"
mkdir -p "${NESTED_REPO}"
mkcommit "${NESTED_REPO}" "bad message no spec format"
NESTED_BAD_PARENT=$(cut -d' ' -f1 "${NESTED_REPO}/.pair")
NESTED_BAD_SHA=$(cut -d' ' -f2 "${NESTED_REPO}/.pair")

# 清单文件工厂：exempt_file <content>
EXEMPT_FILE="${WORK_ROOT}/exempt.txt"
exempt_file() { printf '%s\n' "$1" > "${EXEMPT_FILE}"; }

# run <name> <expected_exit> <assert_contains|> <oldrev> <newrev> <refname> <repo_dir> [env_kv...]
run() {
    local name="$1" expected="$2" assert="$3"
    local oldrev="$4" newrev="$5" refname="$6" repo_dir="$7"
    shift 7
    local actual=0 out
    out=$(cd "${repo_dir}" && printf '%s %s %s\n' "$oldrev" "$newrev" "$refname" \
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

echo "pre-receive repo-level format-exemption Functional Tests"
echo "================================================"

# === 命中名单：整仓豁免格式校验 ===
exempt_file "# 豁免清单
legacy/team-a
grp/proj
"
run "命中名单 + feature 非法 msg → 放行"        0 "" "${BAD_PARENT}" "${BAD_SHA}" "refs/heads/feature/xyz" "${WORK_REPO}" "PRECEIVE_EXEMPT_REPOS_FILE=${EXEMPT_FILE}" "GL_PROJECT_PATH=grp/proj"
run "命中名单 + develop 非法 msg → 放行"         0 "" "${BAD_PARENT}" "${BAD_SHA}" "refs/heads/develop" "${WORK_REPO}" "PRECEIVE_EXEMPT_REPOS_FILE=${EXEMPT_FILE}" "GL_PROJECT_PATH=grp/proj"

# === merge 管控不豁免（MR 流程门禁与 Uni-AURI 无关）===
run "命中名单 + feature merge → 仍拒绝(MR提示)"  1 "Merge Request" "${BAD_PARENT}" "${MERGE_SHA}" "refs/heads/feature/xyz" "${WORK_REPO}" "PRECEIVE_EXEMPT_REPOS_FILE=${EXEMPT_FILE}" "GL_PROJECT_PATH=grp/proj"
run "命中名单 + main merge → 放行(白名单不受影响)" 0 "" "${BAD_PARENT}" "${MERGE_SHA}" "refs/heads/main" "${WORK_REPO}" "PRECEIVE_EXEMPT_REPOS_FILE=${EXEMPT_FILE}" "GL_PROJECT_PATH=grp/proj"

# === 未命中名单：格式校验照常 ===
run "未命中名单 + 非法 msg → 拒绝"               1 "不符合" "${BAD_PARENT}" "${BAD_SHA}" "refs/heads/feature/xyz" "${WORK_REPO}" "PRECEIVE_EXEMPT_REPOS_FILE=${EXEMPT_FILE}" "GL_PROJECT_PATH=other/repo"
run "前缀相似 grp/proj2 不误命中 → 拒绝"          1 "不符合" "${BAD_PARENT}" "${BAD_SHA}" "refs/heads/feature/xyz" "${WORK_REPO}" "PRECEIVE_EXEMPT_REPOS_FILE=${EXEMPT_FILE}" "GL_PROJECT_PATH=grp/proj2"
run "子路径 grp/proj/sub 不误命中 → 拒绝"         1 "不符合" "${BAD_PARENT}" "${BAD_SHA}" "refs/heads/feature/xyz" "${WORK_REPO}" "PRECEIVE_EXEMPT_REPOS_FILE=${EXEMPT_FILE}" "GL_PROJECT_PATH=grp/proj/sub"

# === fail-safe：清单缺失/为空 = 无豁免 ===
run "清单文件缺失 → 校验照常拒绝"                1 "不符合" "${BAD_PARENT}" "${BAD_SHA}" "refs/heads/feature/xyz" "${WORK_REPO}" "PRECEIVE_EXEMPT_REPOS_FILE=${WORK_ROOT}/not-exist.txt" "GL_PROJECT_PATH=grp/proj"
exempt_file ""
run "清单为空 → 校验照常拒绝"                    1 "不符合" "${BAD_PARENT}" "${BAD_SHA}" "refs/heads/feature/xyz" "${WORK_REPO}" "PRECEIVE_EXEMPT_REPOS_FILE=${EXEMPT_FILE}" "GL_PROJECT_PATH=grp/proj"
exempt_file "# 只有注释
   # 带空白前缀的注释

"
run "清单只有注释/空行 → 校验照常拒绝"            1 "不符合" "${BAD_PARENT}" "${BAD_SHA}" "refs/heads/feature/xyz" "${WORK_REPO}" "PRECEIVE_EXEMPT_REPOS_FILE=${EXEMPT_FILE}" "GL_PROJECT_PATH=grp/proj"

# === 注释/空白 trim 后精确匹配 ===
exempt_file "legacy/team-a
   grp/proj
# 注释 grp/proj
"
run "行首尾空白 trim 后命中 → 放行"               0 "" "${BAD_PARENT}" "${BAD_SHA}" "refs/heads/feature/xyz" "${WORK_REPO}" "PRECEIVE_EXEMPT_REPOS_FILE=${EXEMPT_FILE}" "GL_PROJECT_PATH=grp/proj"

# === $PWD 推导兜底（GL_PROJECT_PATH 为空）===
exempt_file "grp/proj
"
run "PWD repositories/ 布局推导命中 → 放行"       0 "" "${NESTED_BAD_PARENT}" "${NESTED_BAD_SHA}" "refs/heads/feature/xyz" "${NESTED_REPO}" "PRECEIVE_EXEMPT_REPOS_FILE=${EXEMPT_FILE}" "GL_PROJECT_PATH="
run "PWD 推导未命中(路径不在清单) → 拒绝"          1 "不符合" "${BAD_PARENT}" "${BAD_SHA}" "refs/heads/feature/xyz" "${WORK_REPO}" "PRECEIVE_EXEMPT_REPOS_FILE=${EXEMPT_FILE}" "GL_PROJECT_PATH="

# 裸 basename 兜底：WORK_REPO 的 basename 动态写入清单
exempt_file "$(basename "${WORK_REPO}")"
run "PWD 裸 basename 兜底命中 → 放行"             0 "" "${BAD_PARENT}" "${BAD_SHA}" "refs/heads/feature/xyz" "${WORK_REPO}" "PRECEIVE_EXEMPT_REPOS_FILE=${EXEMPT_FILE}" "GL_PROJECT_PATH="

# === GL_PROJECT_PATH 为主：设置时优先于 $PWD 推导 ===
# GL 命中而 PWD 布局不命中 → 仍豁免
run "GL 优先:GL 命中 PWD 不命中 → 放行"          0 "" "${BAD_PARENT}" "${BAD_SHA}" "refs/heads/feature/xyz" "${NESTED_REPO}" "PRECEIVE_EXEMPT_REPOS_FILE=${EXEMPT_FILE}" "GL_PROJECT_PATH=$(basename "${WORK_REPO}")"
# GL 不命中而 PWD 布局会命中 → 不豁免（GL 已设置即权威）
exempt_file "grp/proj
legacy/team-a
"
run "GL 优先:GL 不命中 PWD 会命中 → 拒绝"         1 "不符合" "${NESTED_BAD_PARENT}" "${NESTED_BAD_SHA}" "refs/heads/feature/xyz" "${NESTED_REPO}" "PRECEIVE_EXEMPT_REPOS_FILE=${EXEMPT_FILE}" "GL_PROJECT_PATH=other/repo"

# === 未配置清单路径：默认 hook 同目录（不存在）→ 无豁免，校验照常 ===
run "未配置清单路径(默认无文件) → 拒绝"           1 "不符合" "${BAD_PARENT}" "${BAD_SHA}" "refs/heads/feature/xyz" "${WORK_REPO}" "GL_PROJECT_PATH=grp/proj"

echo "================================================"
echo "Results: ${PASS} passed, ${FAIL} failed"
[ "${FAIL}" -gt 0 ] && exit 1
exit 0
