#!/usr/bin/env bash
# Functional tests for install_skill_deps() and setup --check visibility (Issue !160)
#
# 覆盖：
#   case 1: 正常路径 → 日志文件可能为空，install_ok=1，输出 ✓
#   case 2: npm 失败 → 日志文件含错误内容，多行告警含日志路径，install_ok=0
#   case 3: setup --check 在 ajv 缺失时输出 RED ✗ + "日报/看板提交不可用" 提示
#
# 测试用临时目录，不污染源仓库 node_modules。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SETUP_SH="${SCRIPT_DIR}/../setup/setup-harness.sh"

PASS=0
FAIL=0
CLEANUP_DIRS=""

cleanup() {
    for d in ${CLEANUP_DIRS}; do
        rm -rf "${d}"
    done
}
trap cleanup EXIT

if [ ! -f "${SETUP_SH}" ]; then
    echo "SKIP: setup-harness.sh not found at ${SETUP_SH}"
    exit 1
fi

# 用 source 引入函数（不执行 main）—— 屏蔽 case ... esac 入口
# 方案：直接 bash 执行会跑 main；这里通过 grep 抽取函数体不现实，
# 改为：定义 stub 后 source 脚本（脚本末尾的 case 入口会被执行但
# 因为传 --check-no-run 这样的非法参数而走默认 help 分支退出 0）。
# 更稳妥：把脚本里 install_skill_deps 函数提取出来 source。

extract_function() {
    # 提取 setup-harness.sh 中的指定函数体（含函数名行到 } 结束行）
    local fn="$1"
    local file="$2"
    sed -n "/^${fn}()/,/^}$/p" "$file"
}

# 抽取辅助函数（颜色/info/warn/error）、suggest_install_cmd、install_skill_deps
AUX_FUNCS=$(sed -n '/^GREEN=/,/^section()/p' "${SETUP_SH}")
SUGGEST_FUNC=$(extract_function "suggest_install_cmd" "${SETUP_SH}")
INSTALL_FUNC=$(extract_function "install_skill_deps" "${SETUP_SH}")

# 写到临时 helper 文件，测试中 source 它
HELPER="${SCRIPT_DIR}/.install-skill-deps-helper.tmp.sh"
{
    echo "#!/usr/bin/env bash"
    echo "set -uo pipefail"
    echo "${AUX_FUNCS}"
    echo ""
    echo "${SUGGEST_FUNC}"
    echo ""
    echo "${INSTALL_FUNC}"
} > "${HELPER}"
CLEANUP_DIRS="${CLEANUP_DIRS} ${HELPER}"

echo "install_skill_deps visibility tests (Issue !160)"
echo "================================================"

# ─── case 1: 正常路径 ───────────────────────────────────
# 准备一个临时 target，含 .claude/skills/daily-report/scripts/package.json + lock
# 用真实 npm ci 安装到临时目录（隔离，不污染源仓库）。
# 若环境无 npm，跳过此 case（不视为失败）。

if ! command -v npm &>/dev/null; then
    echo "  case 1 (正常路径): SKIP (npm 不可用)"
else
    T1="$(mktemp -d)"
    CLEANUP_DIRS="${CLEANUP_DIRS} ${T1}"
    SCRIPTS_DIR="${T1}/.claude/skills/daily-report/scripts"
    mkdir -p "${SCRIPTS_DIR}"
    # 用源仓库的真实 package.json + package-lock.json
    SRC_SCRIPTS="${SCRIPT_DIR}/../../../skills/daily-report/scripts"
    cp "${SRC_SCRIPTS}/package.json" "${SCRIPTS_DIR}/"
    [ -f "${SRC_SCRIPTS}/package-lock.json" ] && cp "${SRC_SCRIPTS}/package-lock.json" "${SCRIPTS_DIR}/"

    OUT=$(bash "${HELPER}" <<< "install_skill_deps '${T1}'" 2>&1) || true
    # 重新执行（上面 <<! 语法不靠谱）—— 直接调函数
    OUT=$(source "${HELPER}"; install_skill_deps "${T1}" 2>&1) || true

    LOG_FILE="${T1}/.harness/.setup-install-skill-deps.log"
    if echo "${OUT}" | grep -q "daily-report 依赖安装完成 ✓" && [ -d "${SCRIPTS_DIR}/node_modules/ajv" ]; then
        echo "  case 1 (正常路径): PASS"
        PASS=$((PASS + 1))
    else
        echo "  case 1 (正常路径): FAIL — 未输出 ✓ 或 ajv 未安装"
        echo "    output: ${OUT}"
        FAIL=$((FAIL + 1))
    fi

    # 验证：成功路径下，日志文件要么不存在，要么为空（无错误）—— 不强制要求，但若有则不能含 npm ERR!
    if [ -f "${LOG_FILE}" ] && grep -q "ERR!" "${LOG_FILE}"; then
        echo "  case 1 (日志文件): FAIL — 成功路径日志含 ERR!"
        FAIL=$((FAIL + 1))
    fi
fi

# ─── case 2: npm 失败诊断 ──────────────────────────────
# 模拟失败：写一个 broken package-lock.json（与 package.json 不匹配 + 不可恢复）
# 或用不可写的目录。这里采用：故意写一个 syntactically broken 的 package.json。

T2="$(mktemp -d)"
CLEANUP_DIRS="${CLEANUP_DIRS} ${T2}"
SCRIPTS_DIR2="${T2}/.claude/skills/daily-report/scripts"
mkdir -p "${SCRIPTS_DIR2}"
# broken package.json —— npm ci 会报错
echo "{ this is not valid json" > "${SCRIPTS_DIR2}/package.json"
echo '{"name":"x","lockfileVersion":3}' > "${SCRIPTS_DIR2}/package-lock.json"

OUT2=$(source "${HELPER}"; install_skill_deps "${T2}" 2>&1) || true

LOG_FILE2="${T2}/.harness/.setup-install-skill-deps.log"

# 断言 1: 日志文件生成且非空
if [ -f "${LOG_FILE2}" ] && [ -s "${LOG_FILE2}" ]; then
    echo "  case 2 (日志文件生成): PASS"
    PASS=$((PASS + 1))
else
    echo "  case 2 (日志文件生成): FAIL — 日志文件未生成或为空"
    echo "    expected: ${LOG_FILE2}"
    FAIL=$((FAIL + 1))
fi

# 断言 2: 多行告警输出含日志路径
if echo "${OUT2}" | grep -F "${LOG_FILE2}" | grep -q "."; then
    echo "  case 2 (告警含日志路径): PASS"
    PASS=$((PASS + 1))
else
    echo "  case 2 (告警含日志路径): FAIL — 未在输出中看到日志路径"
    echo "    output: ${OUT2}"
    FAIL=$((FAIL + 1))
fi

# 断言 3: 告警含手动重试命令
if echo "${OUT2}" | grep -q "npm ci --omit=dev"; then
    echo "  case 2 (含手动重试命令): PASS"
    PASS=$((PASS + 1))
else
    echo "  case 2 (含手动重试命令): FAIL — 未看到 npm ci --omit=dev 提示"
    FAIL=$((FAIL + 1))
fi

# 断言 4: 告警含"日报/看板"功能影响说明
if echo "${OUT2}" | grep -Eq "日报|看板|daily-report"; then
    echo "  case 2 (含功能影响说明): PASS"
    PASS=$((PASS + 1))
else
    echo "  case 2 (含功能影响说明): FAIL"
    FAIL=$((FAIL + 1))
fi

# ─── case 3: setup --check 在 ajv 缺失时 RED 提示 ────
# 用源仓库本身做检查，但临时移除 node_modules/ajv（在临时拷贝中操作，不动源仓库）。

T3="$(mktemp -d)"
CLEANUP_DIRS="${CLEANUP_DIRS} ${T3}"
# 拷贝最小骨架（让 --check 能跑到 daily-report 依赖检查段）
mkdir -p "${T3}/.claude/skills/daily-report/scripts"
echo '{"name":"x","dependencies":{"ajv":"^8.0.0"}}' > "${T3}/.claude/skills/daily-report/scripts/package.json"
# 故意不装 node_modules —— 模拟 ajv 缺失

OUT3=$(bash "${SETUP_SH}" --check "${T3}" 2>&1) || true

# 断言: 输出含 RED ✗（\033[0;31m）+ "日报/看板提交不可用"
if echo "${OUT3}" | grep -q $'\033\[0;31m'"✗"; then
    echo "  case 3 (RED ✗ 高亮): PASS"
    PASS=$((PASS + 1))
else
    echo "  case 3 (RED ✗ 高亮): FAIL — 未看到 RED 颜色 ✗"
    echo "    output 片段:"
    echo "${OUT3}" | grep -A1 "daily-report 依赖" | head -5 | sed 's/^/      /'
    FAIL=$((FAIL + 1))
fi

if echo "${OUT3}" | grep -Eq "日报/看板提交不可用|daily-report 依赖.*不可用"; then
    echo "  case 3 (含不可用提示): PASS"
    PASS=$((PASS + 1))
else
    echo "  case 3 (含不可用提示): FAIL"
    FAIL=$((FAIL + 1))
fi

# 断言: 若日志文件存在（case 2 写过 .harness/），--check 也输出日志路径供排查
# 这里 T3 没有自己的日志文件，不强求；只要 RED 提示到位即可。

# ─── case 4: 有 lockfile 时重试命令用 npm ci（C2） ────
T4="$(mktemp -d)"
CLEANUP_DIRS="${CLEANUP_DIRS} ${T4}"
SCRIPTS_DIR4="${T4}/.claude/skills/daily-report/scripts"
mkdir -p "${SCRIPTS_DIR4}"
# broken package.json + lockfile —— 走 npm ci 分支（失败）
echo "{ this is not valid json" > "${SCRIPTS_DIR4}/package.json"
echo '{"name":"x","lockfileVersion":3}' > "${SCRIPTS_DIR4}/package-lock.json"

OUT4=$(source "${HELPER}"; install_skill_deps "${T4}" 2>&1) || true

# 断言: warn 含 npm ci --omit=dev，不含 npm install（避免误导）
if echo "${OUT4}" | grep -q "npm ci --omit=dev" && ! echo "${OUT4}" | grep -q "npm install"; then
    echo "  case 4 (有 lockfile → npm ci): PASS"
    PASS=$((PASS + 1))
else
    echo "  case 4 (有 lockfile → npm ci): FAIL"
    echo "    output: ${OUT4}"
    FAIL=$((FAIL + 1))
fi

# ─── case 5: 无 lockfile 时重试命令用 npm install（C2） ────
T5="$(mktemp -d)"
CLEANUP_DIRS="${CLEANUP_DIRS} ${T5}"
SCRIPTS_DIR5="${T5}/.claude/skills/daily-report/scripts"
mkdir -p "${SCRIPTS_DIR5}"
# broken package.json，无 lockfile —— 走 npm install 分支
echo "{ this is not valid json" > "${SCRIPTS_DIR5}/package.json"
# 故意不创建 package-lock.json

OUT5=$(source "${HELPER}"; install_skill_deps "${T5}" 2>&1) || true

# 断言: warn 含 npm install --omit=dev，不含 npm ci（避免误导）
if echo "${OUT5}" | grep -q "npm install --omit=dev" && ! echo "${OUT5}" | grep -q "npm ci"; then
    echo "  case 5 (无 lockfile → npm install): PASS"
    PASS=$((PASS + 1))
else
    echo "  case 5 (无 lockfile → npm install): FAIL"
    echo "    output: ${OUT5}"
    FAIL=$((FAIL + 1))
fi

# ─── case 6: ensure_gitignore 注入 .harness/.setup-*.log（C1） ────
# 验证：在临时 target 跑 ensure_gitignore，确认 .harness/.setup-*.log 出现在 .gitignore
# 且 git check-ignore 对实际日志文件返回 exit=0。

ENSURE_FUNC=$(extract_function "ensure_gitignore" "${SETUP_SH}")

T6="$(mktemp -d)"
CLEANUP_DIRS="${CLEANUP_DIRS} ${T6}"
# 创造最小 .gitignore
echo "# existing" > "${T6}/.gitignore"

# 抽取 ensure_gitignore + 依赖的 info/warn，独立 source 执行
ENSURE_HELPER="${SCRIPT_DIR}/.ensure-gitignore-helper.tmp.sh"
{
    echo "#!/usr/bin/env bash"
    echo "set -uo pipefail"
    echo "${AUX_FUNCS}"
    echo ""
    echo "${ENSURE_FUNC}"
} > "${ENSURE_HELPER}"
CLEANUP_DIRS="${CLEANUP_DIRS} ${ENSURE_HELPER}"

OUT6=$(source "${ENSURE_HELPER}"; ensure_gitignore "${T6}" 2>&1) || true

# 断言 1: .gitignore 含 .harness/.setup-*.log 规则
if grep -qxF '.harness/.setup-*.log' "${T6}/.gitignore"; then
    echo "  case 6 (gitignore 注入规则): PASS"
    PASS=$((PASS + 1))
else
    echo "  case 6 (gitignore 注入规则): FAIL — .gitignore 未含规则"
    echo "    content:"
    cat "${T6}/.gitignore" | sed 's/^/      /'
    FAIL=$((FAIL + 1))
fi

# 断言 2: git check-ignore 对实际日志文件返回 exit=0（被忽略）
# 先在 target 创建日志文件（ensure_gitignore 不创建文件，只创建规则）
mkdir -p "${T6}/.harness"
touch "${T6}/.harness/.setup-install-skill-deps.log"
# check-ignore 需要在 git 仓库内执行；T6 不是 git 仓库，临时 init 一个。
# 用 GIT_CONFIG_NOSYSTEM 避免读到全局 git 配置干扰。
(
    cd "${T6}" || exit 1
    git init -q 2>/dev/null || true
    git config user.email "t@t" 2>/dev/null || true
    git config user.name "t" 2>/dev/null || true
    git check-ignore ".harness/.setup-install-skill-deps.log" >/dev/null 2>&1
)
RC=$?
if [ "${RC}" -eq 0 ]; then
    echo "  case 6 (check-ignore 通过): PASS"
    PASS=$((PASS + 1))
else
    echo "  case 6 (check-ignore 通过): FAIL — 日志文件未被忽略 (rc=${RC})"
    FAIL=$((FAIL + 1))
fi

echo "================================================"
echo "Results: ${PASS} passed, ${FAIL} failed"
if [ "${FAIL}" -gt 0 ]; then
    exit 1
fi
exit 0
