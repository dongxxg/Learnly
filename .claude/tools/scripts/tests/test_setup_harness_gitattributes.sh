#!/usr/bin/env bash
# Functional tests for setup-harness.sh merge_gitattributes (issue !144, 方案 H)
#
# 验证（分发模板与框架自身规则解耦后）：
#   1. 合并语义（target_missing / target_has_all / target_partial）
#      - 源：$source/.claude/templates/gitattributes.harness（分发模板，仅 * text=auto + 二进制）
#   2. Windows 业务仓库 autocrlf 检测与简化治理提示
#   3. 阈值与误报防护（autocrlf=false、文件数 < 200、非 git 仓库）
#   4. 分发模板内容验证（生产文件）：含 * text=auto + 二进制清单，不含 text eol=lf
#
# 策略：用 awk 从 setup-harness.sh 提取 merge_gitattributes 及其依赖（info/warn/safe_cp），
#       单独 source 进测试进程，避免触发主入口。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SETUP_HARNESS="${SCRIPT_DIR}/../setup/setup-harness.sh"
# SCRIPT_DIR = .claude/tools/scripts/tests/ → 往上 4 层到 rd_harness/
HARNESS_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
PROD_TEMPLATE="${HARNESS_ROOT}/.claude/templates/gitattributes.harness"

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

# ────────────────────────────────────────────────
# 提取 merge_gitattributes + 依赖（避免主入口副作用）
# 用 awk 按函数名定位起止行，行号漂移也能跟随。
# 依赖：颜色常量 + info/warn/safe_cp（72-84 行块，原生产文件稳定）
#       + merge_gitattributes 函数体（从 `merge_gitattributes() {` 到下一个顶层 `}`）
# ────────────────────────────────────────────────
EXTRACT="${SCRIPT_DIR}/.extracted_helpers.$$"
trap 'rm -f "${EXTRACT}"' EXIT
{
    sed -n '72,84p' "${SETUP_HARNESS}"
    echo ""
    awk '
        /^merge_gitattributes\(\) \{/ { in_fn = 1 }
        in_fn { print }
        in_fn && /^\}/ { in_fn = 0 }
    ' "${SETUP_HARNESS}"
} > "${EXTRACT}"
# 校验提取内容非空（函数定位成功）
if ! grep -q '^merge_gitattributes()' "${EXTRACT}"; then
    echo "FATAL: 未能从 setup-harness.sh 提取 merge_gitattributes（函数定位失败）" >&2
    exit 99
fi
# shellcheck disable=SC1090
source "${EXTRACT}"

# ────────────────────────────────────────────────
# 工作区：一个框架源目录 + 多个目标目录
# 模拟"框架仓库"：分发模板放在 .claude/templates/gitattributes.harness
# ────────────────────────────────────────────────
TMP="$(mktemp -d)"
CLEANUP_DIRS="${TMP}"

# 构造框架源"分发模板"（与生产模板语义一致：仅默认规则 + 二进制，不含 eol=lf）
mkdir -p "${TMP}/framework/.claude/templates"
cat > "${TMP}/framework/.claude/templates/gitattributes.harness" <<'EOF'
# 默认规则
* text=auto
# 二进制
*.png binary
*.jar binary
EOF

echo "── Test 1: target 无 .gitattributes → 整体复制（从分发模板） ──"
mkdir -p "${TMP}/t1"
OUTPUT="$(merge_gitattributes "${TMP}/framework" "${TMP}/t1" 2>&1 || true)"
assert_contains "1.1 提示创建" "创建 \.gitattributes" "${OUTPUT}" "未提示创建"
if [ -f "${TMP}/t1/.gitattributes" ]; then
    echo "  1.2 文件已创建: PASS"; PASS=$((PASS + 1))
else
    echo "  1.2 文件已创建: FAIL — 文件不存在"; FAIL=$((FAIL + 1))
fi
if diff -q "${TMP}/framework/.claude/templates/gitattributes.harness" "${TMP}/t1/.gitattributes" >/dev/null; then
    echo "  1.3 内容与分发模板一致: PASS"; PASS=$((PASS + 1))
else
    echo "  1.3 内容与分发模板一致: FAIL"; FAIL=$((FAIL + 1))
fi
# 注入的内容必须不含 eol=lf（方案 H 核心：分发模板不追溯业务方历史）
if ! grep -q "eol=lf" "${TMP}/t1/.gitattributes"; then
    echo "  1.4 注入内容不含 eol=lf（不追溯业务方历史）: PASS"; PASS=$((PASS + 1))
else
    echo "  1.4 注入内容不含 eol=lf: FAIL"; FAIL=$((FAIL + 1))
fi

echo ""
echo "── Test 2: target 已包含全部规则 → 0 追加 ──"
mkdir -p "${TMP}/t2"
cp "${TMP}/framework/.claude/templates/gitattributes.harness" "${TMP}/t2/.gitattributes"
OUTPUT="$(merge_gitattributes "${TMP}/framework" "${TMP}/t2" 2>&1 || true)"
assert_contains "2.1 提示已包含全部" "已包含全部框架规则" "${OUTPUT}" "未提示已包含全部"
# 文件内容不应变化
if diff -q "${TMP}/framework/.claude/templates/gitattributes.harness" "${TMP}/t2/.gitattributes" >/dev/null; then
    echo "  2.2 文件未变化: PASS"; PASS=$((PASS + 1))
else
    echo "  2.2 文件未变化: FAIL — 文件被修改"; FAIL=$((FAIL + 1))
fi

echo ""
echo "── Test 3: target 缺 2 条二进制 → 追加 2 条 ──"
mkdir -p "${TMP}/t3"
# 仅保留默认规则 + 1 条二进制（*.png），缺 *.jar
cat > "${TMP}/t3/.gitattributes" <<'EOF'
# 默认
* text=auto
*.png binary
EOF
OUTPUT="$(merge_gitattributes "${TMP}/framework" "${TMP}/t3" 2>&1 || true)"
assert_contains "3.1 提示补充 1 条" "补充 1 条规则" "${OUTPUT}" "未提示补充 1 条"
# 验证 *.jar 已追加
if grep -q "^\*\.jar binary$" "${TMP}/t3/.gitattributes"; then
    echo "  3.2 缺失规则已追加: PASS"; PASS=$((PASS + 1))
else
    echo "  3.2 缺失规则已追加: FAIL"; FAIL=$((FAIL + 1))
fi
# 已有规则不应重复
PNG_COUNT=$(grep -c "^\*\.png binary$" "${TMP}/t3/.gitattributes" || true)
if [ "${PNG_COUNT}" -eq 1 ]; then
    echo "  3.3 已有规则未重复: PASS"; PASS=$((PASS + 1))
else
    echo "  3.3 已有规则未重复: FAIL — 重复 ${PNG_COUNT} 次"; FAIL=$((FAIL + 1))
fi

echo ""
echo "── Test 4: autocrlf=true + 250 文件 → 输出 Windows 业务仓库提示（简化文案） ──"
# 构造一个伪 git 仓库目录：放 .git/，git -C xxx config/get/ls-files 用 stub 拦截
T4="${TMP}/t4"
mkdir -p "${T4}/.git"
mkdir -p "${TMP}/stubs"
# git stub：在 T4 下返回 autocrlf=true + 250 文件
cat > "${TMP}/stubs/git" <<EOF
#!/usr/bin/env bash
# 拦截 git -C <T4> config --get core.autocrlf → true
# 拦截 git -C <T4> ls-files → 250 行
if [ "\$1" = "-C" ] && [ "\$2" = "${T4}" ]; then
    shift 2
    if [ "\$1" = "config" ] && [ "\$2" = "--get" ] && [ "\$3" = "core.autocrlf" ]; then
        echo "true"; exit 0
    fi
    if [ "\$1" = "ls-files" ]; then
        seq 1 250; exit 0
    fi
    # 伪 git 仓库须应答 rev-parse（merge_gitattributes 非 git 守门用）；
    # 否则 fall-through exec git 经 PATH 再次命中本 stub，无限递归。
    if [ "\$1" = "rev-parse" ] && [ "\$2" = "--is-inside-work-tree" ]; then
        echo "true"; exit 0
    fi
fi
exec /usr/bin/env git "\$@"
EOF
chmod +x "${TMP}/stubs/git"
cp "${TMP}/framework/.claude/templates/gitattributes.harness" "${T4}/.gitattributes"
OUTPUT="$(PATH="${TMP}/stubs:${PATH}" merge_gitattributes "${TMP}/framework" "${T4}" 2>&1 || true)"
assert_contains "4.1 提示 Windows 业务仓库检测" "Windows 业务仓库检测" "${OUTPUT}" "未输出 Windows 检测提示"
assert_contains "4.2 显示 autocrlf=true" "core\.autocrlf=true" "${OUTPUT}" "未显示 autocrlf=true"
assert_contains "4.3 显示文件数 250" "250 个跟踪文件" "${OUTPUT}" "未显示文件数"
# 简化文案：方案 A 仍保留（标准化建议），方案 B 改为"如需严格 LF 业务方自行添加"
assert_contains "4.4 提示方案 A renormalize" "git add --renormalize" "${OUTPUT}" "未提示方案 A"
assert_contains "4.5 提示业务方自治" "自行添加" "${OUTPUT}" "未提示业务方自治"
assert_contains "4.6 引用 issue !144" "issue !144" "${OUTPUT}" "未引用 issue"

echo ""
echo "── Test 5: autocrlf=true + 100 文件（< 200 阈值） → 不输出警告 ──"
T5="${TMP}/t5"
mkdir -p "${T5}/.git"
cat > "${TMP}/stubs/git" <<EOF
#!/usr/bin/env bash
if [ "\$1" = "-C" ] && [ "\$2" = "${T5}" ]; then
    shift 2
    if [ "\$1" = "config" ] && [ "\$2" = "--get" ] && [ "\$3" = "core.autocrlf" ]; then
        echo "true"; exit 0
    fi
    if [ "\$1" = "ls-files" ]; then
        seq 1 100; exit 0
    fi
    if [ "\$1" = "rev-parse" ] && [ "\$2" = "--is-inside-work-tree" ]; then
        echo "true"; exit 0
    fi
fi
exec /usr/bin/env git "\$@"
EOF
chmod +x "${TMP}/stubs/git"
cp "${TMP}/framework/.claude/templates/gitattributes.harness" "${T5}/.gitattributes"
OUTPUT="$(PATH="${TMP}/stubs:${PATH}" merge_gitattributes "${TMP}/framework" "${T5}" 2>&1 || true)"
assert_not_contains "5.1 不输出 Windows 警告" "Windows 业务仓库检测" "${OUTPUT}" "误报：文件数 < 200 不应警告"

echo ""
echo "── Test 6: autocrlf=false + 1000 文件 → 不输出警告 ──"
T6="${TMP}/t6"
mkdir -p "${T6}/.git"
cat > "${TMP}/stubs/git" <<EOF
#!/usr/bin/env bash
if [ "\$1" = "-C" ] && [ "\$2" = "${T6}" ]; then
    shift 2
    if [ "\$1" = "config" ] && [ "\$2" = "--get" ] && [ "\$3" = "core.autocrlf" ]; then
        echo "false"; exit 0
    fi
    if [ "\$1" = "ls-files" ]; then
        seq 1 1000; exit 0
    fi
    if [ "\$1" = "rev-parse" ] && [ "\$2" = "--is-inside-work-tree" ]; then
        echo "true"; exit 0
    fi
fi
exec /usr/bin/env git "\$@"
EOF
chmod +x "${TMP}/stubs/git"
cp "${TMP}/framework/.claude/templates/gitattributes.harness" "${T6}/.gitattributes"
OUTPUT="$(PATH="${TMP}/stubs:${PATH}" merge_gitattributes "${TMP}/framework" "${T6}" 2>&1 || true)"
assert_not_contains "6.1 不输出 Windows 警告" "Windows 业务仓库检测" "${OUTPUT}" "误报：autocrlf=false 不应警告"

echo ""
echo "── Test 7: 非 git 仓库（无 .git，git stub 透传失败） → 静默跳过 ──"
T7="${TMP}/t7"
mkdir -p "${T7}"
cp "${TMP}/framework/.claude/templates/gitattributes.harness" "${T7}/.gitattributes"
# 移除 git stub，PATH 中真实 git 对非仓库目录返回非 0；merge_gitattributes 不应报错
OUTPUT="$(merge_gitattributes "${TMP}/framework" "${T7}" 2>&1 || true)"
assert_not_contains "7.1 非 git 仓库不报错" "Windows 业务仓库检测" "${OUTPUT}" "非 git 仓库误报"
# 合并仍应正常完成（提示已包含全部）
assert_contains "7.2 合并逻辑正常" "已包含全部框架规则" "${OUTPUT}" "非 git 仓库合并中断"

echo ""
echo "── Test 8: 生产分发模板内容验证（.claude/templates/gitattributes.harness） ──"
if [ ! -f "${PROD_TEMPLATE}" ]; then
    echo "  8.0 生产模板存在: FAIL — ${PROD_TEMPLATE} 不存在"; FAIL=$((FAIL + 1))
else
    echo "  8.0 生产模板存在: PASS"; PASS=$((PASS + 1))
    PROD_CONTENT="$(cat "${PROD_TEMPLATE}")"
    # 必含 * text=auto（默认规则，让 git 自动检测）
    assert_contains "8.1 含默认规则 * text=auto" "^\* text=auto" "${PROD_CONTENT}" "缺少默认规则"
    # 必含二进制清单（至少 *.png / *.jar）
    assert_contains "8.2 含 *.png binary" "\*\.png binary" "${PROD_CONTENT}" "缺少 *.png binary"
    assert_contains "8.3 含 *.jar binary" "\*\.jar binary" "${PROD_CONTENT}" "缺少 *.jar binary"
    # 方案 H 核心：分发模板不得含任何 text eol=lf（不追溯业务方历史文件）
    assert_not_contains "8.4 不含 eol=lf（不追溯业务方历史）" "eol=lf" "${PROD_CONTENT}" "分发模板含 eol=lf，会追溯业务方历史"
fi

echo ""
echo "── Test 9: 框架源仓库 .gitattributes 保留显式 eol=lf（框架自身用） ──"
# 方案 H：分发模板与框架自身规则解耦——框架源仓库 .gitattributes 仍保留显式 eol=lf
FW_GA="${HARNESS_ROOT}/.gitattributes"
if [ ! -f "${FW_GA}" ]; then
    echo "  9.0 框架源 .gitattributes 存在: FAIL — ${FW_GA} 不存在"; FAIL=$((FAIL + 1))
else
    echo "  9.0 框架源 .gitattributes 存在: PASS"; PASS=$((PASS + 1))
    FW_CONTENT="$(cat "${FW_GA}")"
    # 框架自身仍强制脚本 LF（跨平台一致性）
    assert_contains "9.1 框架 *.sh text eol=lf 保留" "\*\.sh text eol=lf" "${FW_CONTENT}" "框架源 *.sh eol=lf 丢失"
    assert_contains "9.2 框架 *.py text eol=lf 保留" "\*\.py text eol=lf" "${FW_CONTENT}" "框架源 *.py eol=lf 丢失"
    # 框架自身 .gitattributes 无全局 eol=lf（fd2f779 改动保留）
    if ! grep -qE "^\* text=auto eol=lf" "${FW_CONTENT}"; then
        echo "  9.3 框架无全局 * text=auto eol=lf: PASS"; PASS=$((PASS + 1))
    else
        echo "  9.3 框架无全局 * text=auto eol=lf: FAIL — 仍有全局强制 LF"; FAIL=$((FAIL + 1))
    fi
fi

echo ""
echo "── Test 10: 非 git 仓库（直接调用，set -e 活跃） → 不崩溃，正常合并 ──"
# 回归 test-report C1：production 在 L673/L1462 直接调用 merge_gitattributes
# （无 || true），set -e 活跃。L523 file_count 行在非 git 目标下 EXIT 128，
# 导致 install.sh 整体失败。现有 Test 7 套了 || true，恰好禁用函数体内 set -e，
# 无法捕获本 bug——故本用例在子 shell 内显式开启 set -e 复现 production 语义。
T10="${TMP}/t10"
mkdir -p "${T10}"
cp "${TMP}/framework/.claude/templates/gitattributes.harness" "${T10}/.gitattributes"
set +e
T10_OUT="$(set -e; merge_gitattributes "${TMP}/framework" "${T10}" 2>&1)"
T10_RC=$?
set -e
echo -n "  10.1 非 git 目标直接调用返回 0（不 EXIT 128）: "
if [ "${T10_RC}" -eq 0 ]; then echo "PASS"; PASS=$((PASS + 1)); else echo "FAIL — rc=${T10_RC}"; FAIL=$((FAIL + 1)); fi
assert_contains "10.2 合并逻辑正常完成" "已包含全部框架规则" "${T10_OUT}" "非 git 目标下函数中途退出（EXIT 128）"

echo ""
echo "================================================"
echo "Results: PASS=${PASS} FAIL=${FAIL}"
[ "${FAIL}" -eq 0 ]
