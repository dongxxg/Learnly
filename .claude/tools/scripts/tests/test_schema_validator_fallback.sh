#!/usr/bin/env bash
# Functional tests for schema-validator.js loadAjv() fallback resolution (Issue !160)
#
# 覆盖：
#   case 1: ajv 在 daily-report/scripts/node_modules → 正常加载
#   case 2: ajv 缺失但 daily-report-legacy/scripts/node_modules 有 → fallback 加载成功
#   case 3: NODE_PATH 环境变量指向有效路径 → 优先用 NODE_PATH
#   case 4: 全部 fallback 路径缺 ajv → throw Error 含 "ajv dependency not found"
#   case 5: 错误 message 完整（含 setup-harness.sh / npm install / NODE_PATH 三条指引）
#
# 测试用 mktemp -d 造 mock 目录，child_process 跑独立 node 进程，
# 不污染真实仓库 node_modules，也不被主进程 require 缓存干扰。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
VALIDATOR="${REPO_ROOT}/.claude/skills/daily-report/scripts/lib/schema-validator.js"

PASS=0
FAIL=0
CLEANUP_DIRS=""

cleanup() {
    for d in ${CLEANUP_DIRS}; do
        rm -rf "${d}"
    done
}
trap cleanup EXIT

if [ ! -f "${VALIDATOR}" ]; then
    echo "SKIP: schema-validator.js not found at ${VALIDATOR}"
    exit 1
fi

if ! command -v node &>/dev/null; then
    echo "SKIP: node not available"
    exit 1
fi

# 真实仓库里的 ajv 真包路径（用于复制到 mock 目录）
REAL_DAILY_NM="${REPO_ROOT}/.claude/skills/daily-report/scripts/node_modules"
REAL_LEGACY_NM="${REPO_ROOT}/.claude/skills/daily-report-legacy/scripts/node_modules"

echo "schema-validator loadAjv fallback tests (Issue !160)"
echo "====================================================="

# 辅助：在子进程中加载 schema-validator.js，传入 mock 环境变量与 NODE_PATH
# 参数：
#   $1: mock repo root（含 .claude/skills/... 结构）
#   $2: NODE_PATH 值（可为空）
# stdout: 子进程的 stdout
# 注意：子进程 require 时，schema-validator.js 的 __dirname 是真实仓库路径，
#       所以必须用 require.cache 删除 + Module._pathList Hack 重定向。
#       更稳妥：直接复制 schema-validator.js + schemas 到 mock 目录，
#       子进程从 mock 路径 require。
run_validator_load() {
    local mock_root="$1"
    local node_path="$2"
    # 在子进程中 require mock 副本，调用 loadAjv() 看是否成功
    local runner
    runner=$(cat <<'NODE_EOF'
const path = require('path');
const modPath = process.env.MOCK_VALIDATOR_PATH;
const mod = require(modPath);
try {
    mod.loadAjv();
    console.log('LOAD_OK');
} catch (e) {
    console.log('LOAD_FAIL:' + (e && e.message ? e.message : String(e)));
}
NODE_EOF
)
    MOCK_VALIDATOR_PATH="${mock_root}/.claude/skills/daily-report/scripts/lib/schema-validator.js" \
        NODE_PATH="${node_path}" \
        node -e "${runner}"
}

# 准备 mock 仓库：复制 schema-validator.js + schemas 目录
# 参数：$1 = mock_root
# 在 mock_root 下创建：
#   .claude/skills/daily-report/scripts/lib/schema-validator.js
#   .claude/skills/daily-report/scripts/schemas/*.json
#   .claude/skills/daily-report-legacy/scripts/  (空)
setup_mock_skeleton() {
    local mock_root="$1"
    local scripts_dir="${mock_root}/.claude/skills/daily-report/scripts"
    local schemas_dir="${mock_root}/.claude/skills/daily-report/schemas"
    local legacy_scripts_dir="${mock_root}/.claude/skills/daily-report-legacy/scripts"
    mkdir -p "${scripts_dir}/lib" "${schemas_dir}" "${legacy_scripts_dir}"
    cp "${VALIDATOR}" "${scripts_dir}/lib/schema-validator.js"
    cp "${REPO_ROOT}/.claude/skills/daily-report/schemas/"*.json "${schemas_dir}/"
}

# ─── case 1: ajv 在 daily-report/scripts/node_modules → 正常加载 ───
T1="$(mktemp -d)"
CLEANUP_DIRS="${CLEANUP_DIRS} ${T1}"
setup_mock_skeleton "${T1}"
cp -R "${REAL_DAILY_NM}" "${T1}/.claude/skills/daily-report/scripts/node_modules"

OUT1=$(run_validator_load "${T1}" "")
if echo "${OUT1}" | grep -q "LOAD_OK"; then
    echo "  case 1 (primary path loads ajv): PASS"
    PASS=$((PASS + 1))
else
    echo "  case 1 (primary path loads ajv): FAIL"
    echo "    output: ${OUT1}"
    FAIL=$((FAIL + 1))
fi

# ─── case 2: ajv 缺失但 daily-report-legacy/scripts/node_modules 有 ───
T2="$(mktemp -d)"
CLEANUP_DIRS="${CLEANUP_DIRS} ${T2}"
setup_mock_skeleton "${T2}"
# 不复制 daily-report/scripts/node_modules —— 主路径缺 ajv
# 复制 legacy/node_modules —— fallback 路径有 ajv
cp -R "${REAL_LEGACY_NM}" "${T2}/.claude/skills/daily-report-legacy/scripts/node_modules"

OUT2=$(run_validator_load "${T2}" "")
if echo "${OUT2}" | grep -q "LOAD_OK"; then
    echo "  case 2 (fallback to daily-report-legacy): PASS"
    PASS=$((PASS + 1))
else
    echo "  case 2 (fallback to daily-report-legacy): FAIL"
    echo "    output: ${OUT2}"
    FAIL=$((FAIL + 1))
fi

# ─── case 3: NODE_PATH 优先级最高 ───
T3="$(mktemp -d)"
CLEANUP_DIRS="${CLEANUP_DIRS} ${T3}"
setup_mock_skeleton "${T3}"
# 既不放 daily-report/scripts/node_modules，也不放 legacy
# 只在 NODE_PATH 指向的目录里有 ajv
NODE_PATH_DIR="${T3}/external-node-path/.claude/skills/daily-report-legacy/scripts/node_modules"
mkdir -p "$(dirname "${NODE_PATH_DIR}")"
cp -R "${REAL_DAILY_NM}" "${NODE_PATH_DIR}"

OUT3=$(run_validator_load "${T3}" "${NODE_PATH_DIR}")
if echo "${OUT3}" | grep -q "LOAD_OK"; then
    echo "  case 3 (NODE_PATH takes precedence): PASS"
    PASS=$((PASS + 1))
else
    echo "  case 3 (NODE_PATH takes precedence): FAIL"
    echo "    output: ${OUT3}"
    FAIL=$((FAIL + 1))
fi

# ─── case 4: 全部 fallback 缺 ajv → throw "ajv dependency not found" ───
T4="$(mktemp -d)"
CLEANUP_DIRS="${CLEANUP_DIRS} ${T4}"
setup_mock_skeleton "${T4}"
# 不复制任何 node_modules

OUT4=$(run_validator_load "${T4}" "")
if echo "${OUT4}" | grep -q "LOAD_FAIL" && echo "${OUT4}" | grep -q "ajv dependency not found"; then
    echo "  case 4 (all paths missing → throws): PASS"
    PASS=$((PASS + 1))
else
    echo "  case 4 (all paths missing → throws): FAIL"
    echo "    output: ${OUT4}"
    FAIL=$((FAIL + 1))
fi

# ─── case 5: 错误 message 完整（含 3 条修复指引） ───
# 复用 case 4 的输出
if echo "${OUT4}" | grep -q "setup-harness.sh" \
    && echo "${OUT4}" | grep -q "npm install" \
    && echo "${OUT4}" | grep -q "NODE_PATH"; then
    echo "  case 5 (error message includes all 3 remediation hints): PASS"
    PASS=$((PASS + 1))
else
    echo "  case 5 (error message includes all 3 remediation hints): FAIL"
    echo "    output: ${OUT4}"
    FAIL=$((FAIL + 1))
fi

echo "====================================================="
echo "Result: ${PASS} passed, ${FAIL} failed"
if [ "${FAIL}" -gt 0 ]; then
    exit 1
fi
exit 0
