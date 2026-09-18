#!/usr/bin/env bash
# Functional tests for setup-harness.sh batch dispatch mode (.harness-projects)
#
# 策略：用 HARNESS_BATCH_DRY_RUN=1 拦截真实安装，端到端验证分发逻辑。
# 对"跳过批量"的场景（无清单/child 模式/显式参数），检查输出不含"批量分发模式"字样。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SETUP_HARNESS="${SCRIPT_DIR}/../setup/setup-harness.sh"

if [ ! -f "${SETUP_HARNESS}" ]; then
    echo "SKIP: setup-harness.sh not found at ${SETUP_HARNESS}"
    exit 0
fi

PASS=0
FAIL=0
CLEANUP_DIRS=""

cleanup() {
    for d in ${CLEANUP_DIRS}; do
        rm -rf "${d}" 2>/dev/null || true
    done
}
trap cleanup EXIT

assert_contains() {
    local test_name="$1" pattern="$2" output="$3" msg="$4"
    echo -n "  ${test_name}: "
    if echo "${output}" | grep -qE "${pattern}"; then
        echo "PASS"; PASS=$((PASS + 1))
    else
        echo "FAIL — ${msg}"; FAIL=$((FAIL + 1))
    fi
}

assert_not_contains() {
    local test_name="$1" pattern="$2" output="$3" msg="$4"
    echo -n "  ${test_name}: "
    if echo "${output}" | grep -qE "${pattern}"; then
        echo "FAIL — ${msg}"; FAIL=$((FAIL + 1))
    else
        echo "PASS"; PASS=$((PASS + 1))
    fi
}

# 工作区
TMP="$(mktemp -d)"
CLEANUP_DIRS="${TMP}"
mkdir -p "${TMP}/target1" "${TMP}/target2" "${TMP}/projA/sub"

echo "── Test 1: 有 .harness-projects + DRY_RUN → 触发批量分发 ──"
cat > "${TMP}/.harness-projects" <<EOF
# 目标列表
target1
target2
EOF
OUTPUT="$(cd "${TMP}" && HARNESS_BATCH_DRY_RUN=1 bash "${SETUP_HARNESS}" 2>&1 || true)"
assert_contains "1.1 进入批量分发" "批量分发模式" "${OUTPUT}" "未进入批量分发"
assert_contains "1.2 DRY-RUN target1" "\[DRY-RUN\].*target1" "${OUTPUT}" "target1 未出现"
assert_contains "1.3 DRY-RUN target2" "\[DRY-RUN\].*target2" "${OUTPUT}" "target2 未出现"
assert_contains "1.4 汇总信息" "总计 2" "${OUTPUT}" "汇总未显示"

echo ""
echo "── Test 2: 相对路径相对清单文件目录解析 ──"
cat > "${TMP}/projA/.harness-projects" <<EOF
sub
EOF
OUTPUT="$(cd "${TMP}/projA" && HARNESS_BATCH_DRY_RUN=1 bash "${SETUP_HARNESS}" 2>&1 || true)"
assert_contains "2.1 解析为 projA/sub" "\[DRY-RUN\].*/projA/sub" "${OUTPUT}" "相对路径未正确解析"
assert_not_contains "2.2 未误判为不存在" "跳过（路径不存在）" "${OUTPUT}" "误判 sub 为不存在"

echo ""
echo "── Test 3: 不存在的路径 → 跳过 + warn，不中断 ──"
cat > "${TMP}/.harness-projects" <<EOF
target1
nonexistent-xyz
target2
EOF
OUTPUT="$(cd "${TMP}" && HARNESS_BATCH_DRY_RUN=1 bash "${SETUP_HARNESS}" 2>&1 || true)"
assert_contains "3.1 跳过不存在路径" "跳过（路径不存在）：nonexistent-xyz" "${OUTPUT}" "未跳过"
assert_contains "3.2 仍处理其他路径" "\[DRY-RUN\].*target1" "${OUTPUT}" "中断了后续目标"
assert_contains "3.3 跳过数=1" "跳过 1" "${OUTPUT}" "跳过数错误"

echo ""
echo "── Test 4: 注释行和空行跳过 ──"
printf '# 注释\ntarget1\n\n   \ntarget2\n' > "${TMP}/.harness-projects"
OUTPUT="$(cd "${TMP}" && HARNESS_BATCH_DRY_RUN=1 bash "${SETUP_HARNESS}" 2>&1 || true)"
assert_contains "4.1 总计 2（跳过注释/空行）" "总计 2" "${OUTPUT}" "未跳过注释或空行"

echo ""
echo "── Test 5: 绝对路径支持 ──"
cat > "${TMP}/.harness-projects" <<EOF
${TMP}/target1
EOF
OUTPUT="$(cd "${TMP}" && HARNESS_BATCH_DRY_RUN=1 bash "${SETUP_HARNESS}" 2>&1 || true)"
assert_contains "5.1 绝对路径处理" "\[DRY-RUN\].*target1" "${OUTPUT}" "绝对路径未处理"
assert_not_contains "5.2 未误判" "跳过（路径不存在）" "${OUTPUT}" "绝对路径被误判"

echo ""
echo "── Test 6: HARNESS_PROJECTS_FILE 自定义文件名 ──"
cat > "${TMP}/my-projects.txt" <<EOF
target1
EOF
OUTPUT="$(cd "${TMP}" && HARNESS_PROJECTS_FILE=my-projects.txt HARNESS_BATCH_DRY_RUN=1 bash "${SETUP_HARNESS}" 2>&1 || true)"
assert_contains "6.1 使用自定义清单" "my-projects.txt" "${OUTPUT}" "未识别自定义文件名"
assert_contains "6.2 不读默认名" "总计 1" "${OUTPUT}" "数量错误（可能误读默认文件）"

echo ""
echo "── Test 7: 显式参数 --help → 跳过批量分发 ──"
# 保留 .harness-projects，但带 --help 应该跳过
cat > "${TMP}/.harness-projects" <<EOF
target1
EOF
OUTPUT="$(cd "${TMP}" && bash "${SETUP_HARNESS}" --help 2>&1 || true)"
assert_not_contains "7.1 --help 不触发批量" "批量分发模式" "${OUTPUT}" "--help 意外触发批量分发"
assert_contains "7.2 打印帮助" "Uni-AURI 一键安装脚本" "${OUTPUT}" "未打印帮助"

echo ""
echo "── Test 8: 无 .harness-projects → 不触发批量 ──"
EMPTY_TMP="$(mktemp -d)"
CLEANUP_DIRS="${CLEANUP_DIRS} ${EMPTY_TMP}"
# 此目录无清单，CWD 也无；脚本祖先（rd_harness 仓库）也无
OUTPUT="$(cd "${EMPTY_TMP}" && bash "${SETUP_HARNESS}" 2>&1 || true)"
assert_not_contains "8.1 不触发批量分发" "批量分发模式" "${OUTPUT}" "未找到清单时意外触发批量"

echo ""
echo "── Test 9: do_install_lite 只装 hooks + CI，不装 CLAUDE.md/skills/commands ──"
# 真实跑一次批量分发（不用 DRY_RUN），验证 lite 语义
cat > "${TMP}/.harness-projects" <<EOF
target1
EOF
# 跑批量分发（do_install_lite），允许失败但不退出测试脚本
(cd "${TMP}" && bash "${SETUP_HARNESS}" 2>&1) > "${TMP}/.install-output" || true
OUTPUT="$(cat "${TMP}/.install-output")"
assert_contains "9.1 触发轻量安装" "轻量安装" "${OUTPUT}" "未进入轻量安装模式"
# target1 应有 hook 源 + setup-hooks.sh + ci-templates
[ -d "${TMP}/target1/.claude/hooks/git" ] && { echo "  9.2 装了 .claude/hooks/git: PASS"; PASS=$((PASS + 1)); } || { echo "  9.2 装了 .claude/hooks/git: FAIL — 未装 hooks 源"; FAIL=$((FAIL + 1)); }
[ -f "${TMP}/target1/.claude/tools/scripts/setup/setup-hooks.sh" ] && { echo "  9.3 装了 setup-hooks.sh: PASS"; PASS=$((PASS + 1)); } || { echo "  9.3 装了 setup-hooks.sh: FAIL"; FAIL=$((FAIL + 1)); }
[ -d "${TMP}/target1/.claude/ci-templates" ] && { echo "  9.4 装了 ci-templates: PASS"; PASS=$((PASS + 1)); } || { echo "  9.4 装了 ci-templates: FAIL"; FAIL=$((FAIL + 1)); }
# 不应该装：CLAUDE.md / skills / commands / rules / agents / workflows / .harness/
[ ! -f "${TMP}/target1/CLAUDE.md" ] && { echo "  9.5 未装 CLAUDE.md: PASS"; PASS=$((PASS + 1)); } || { echo "  9.5 未装 CLAUDE.md: FAIL — 不该装"; FAIL=$((FAIL + 1)); }
[ ! -d "${TMP}/target1/.claude/skills" ] && { echo "  9.6 未装 skills: PASS"; PASS=$((PASS + 1)); } || { echo "  9.6 未装 skills: FAIL — 不该装"; FAIL=$((FAIL + 1)); }
[ ! -d "${TMP}/target1/.claude/commands" ] && { echo "  9.7 未装 commands: PASS"; PASS=$((PASS + 1)); } || { echo "  9.7 未装 commands: FAIL"; FAIL=$((FAIL + 1)); }
[ ! -d "${TMP}/target1/.harness" ] && { echo "  9.8 未装 .harness/: PASS"; PASS=$((PASS + 1)); } || { echo "  9.8 未装 .harness/: FAIL"; FAIL=$((FAIL + 1)); }

echo ""
echo "── Test 10: 行内前后空白去除 ──"
printf '   target1   \n\ttarget2\t\n' > "${TMP}/.harness-projects"
OUTPUT="$(cd "${TMP}" && HARNESS_BATCH_DRY_RUN=1 bash "${SETUP_HARNESS}" 2>&1 || true)"
assert_contains "10.1 总计 2（去空白后）" "总计 2" "${OUTPUT}" "未正确去除行首尾空白"

echo ""
echo "── Test 11: install.sh 透传场景：参数 = CWD → 触发批量 ──"
cat > "${TMP}/.harness-projects" <<EOF
target1
EOF
# 模拟 install.sh: bash setup-harness.sh "$TARGET"，TARGET 解析后 = CWD 绝对路径
CWD_ABS="$(cd "${TMP}" && pwd)"
OUTPUT="$(cd "${TMP}" && HARNESS_BATCH_DRY_RUN=1 bash "${SETUP_HARNESS}" "${CWD_ABS}" 2>&1 || true)"
assert_contains "11.1 参数=CWD 触发批量" "批量分发模式" "${OUTPUT}" "参数=CWD 时未触发批量"
assert_contains "11.2 处理清单目标" "\[DRY-RUN\].*target1" "${OUTPUT}" "未处理清单目标"

echo ""
echo "── Test 12: 有 .harness-projects + 传别的目录参数 → 仍触发批量（用户责任）──"
mkdir -p "${TMP}/other-dir"
cat > "${TMP}/.harness-projects" <<EOF
target1
EOF
OUTPUT="$(cd "${TMP}" && HARNESS_BATCH_DRY_RUN=1 bash "${SETUP_HARNESS}" "${TMP}/other-dir" 2>&1 || true)"
assert_contains "12.1 有清单时参数被忽略" "批量分发模式" "${OUTPUT}" "有清单但未触发批量"
assert_contains "12.2 仍读清单目标" "\[DRY-RUN\].*target1" "${OUTPUT}" "未读清单目标"

echo ""
echo "── Test 13: --check 子命令始终跳过批量（即使有清单）──"
cat > "${TMP}/.harness-projects" <<EOF
target1
EOF
OUTPUT="$(cd "${TMP}" && bash "${SETUP_HARNESS}" --check 2>&1 || true)"
assert_not_contains "13.1 --check 不触发批量" "批量分发模式" "${OUTPUT}" "--check 意外触发批量分发"

echo ""
echo "── Test 14: 轻量安装复制 CI 生成器 ci/setup-project.py（Issue !253 根因 A）──"
# ci-setup-project.sh 是 ci/setup-project.py 的 bash 入口，只拷入口不拷生成器 → 子项目 CI 生成必失败
cat > "${TMP}/.harness-projects" <<EOF
target1
EOF
# 真实跑一次批量分发（幂等覆盖），验证生成器随入口一起落地
(cd "${TMP}" && bash "${SETUP_HARNESS}" >/dev/null 2>&1) || true
[ -f "${TMP}/target1/.claude/tools/scripts/ci/setup-project.py" ] && { echo "  14.1 装了 ci/setup-project.py: PASS"; PASS=$((PASS + 1)); } || { echo "  14.1 装了 ci/setup-project.py: FAIL — 缺生成器，CI 生成必失败"; FAIL=$((FAIL + 1)); }
[ -f "${TMP}/target1/.claude/tools/scripts/ci-setup-project.sh" ] && { echo "  14.2 装了 ci-setup-project.sh: PASS"; PASS=$((PASS + 1)); } || { echo "  14.2 装了 ci-setup-project.sh: FAIL"; FAIL=$((FAIL + 1)); }

echo ""
echo "── Test 15: CI 配置生成失败 → 子项目标失败，不吞退出码（Issue !253 根因 B）──"
# 伪造不可用的 python3/python（--version 即失败，模拟 Windows Store 占位符 exit 49 场景），
# 迫使 detect_language 的生成器调用退出非零；target3 必须是 git 仓库才会走 CI 生成。
FAKE_BIN="$(mktemp -d)"
CLEANUP_DIRS="${CLEANUP_DIRS} ${FAKE_BIN}"
printf '#!/usr/bin/env bash\nexit 93\n' > "${FAKE_BIN}/python3"
printf '#!/usr/bin/env bash\nexit 93\n' > "${FAKE_BIN}/python"
chmod +x "${FAKE_BIN}/python3" "${FAKE_BIN}/python"
mkdir -p "${TMP}/target3"
git -C "${TMP}/target3" init -q
cat > "${TMP}/.harness-projects" <<EOF
target3
EOF
(cd "${TMP}" && PATH="${FAKE_BIN}:${PATH}" bash "${SETUP_HARNESS}" 2>&1) > "${TMP}/.batch-out15" || true
OUTPUT="$(cat "${TMP}/.batch-out15")"
assert_contains "15.1 报告 CI 生成失败" "CI 配置生成失败" "${OUTPUT}" "未报告 CI 生成失败"
assert_contains "15.2 汇总计失败 1" "失败 1" "${OUTPUT}" "CI 生成失败但汇总未计失败（退出码被吞）"
[ -d "${TMP}/target3/.claude/hooks/git" ] && { echo "  15.3 CI 失败不影响 hooks 安装: PASS"; PASS=$((PASS + 1)); } || { echo "  15.3 CI 失败不影响 hooks 安装: FAIL — hooks 未装"; FAIL=$((FAIL + 1)); }

echo ""
echo "================================================"
echo "Results: PASS=${PASS} FAIL=${FAIL}"
[ "${FAIL}" -eq 0 ]
