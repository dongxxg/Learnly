#!/usr/bin/env bash
# Tests for setup-harness.sh --check ESM type:module 检查规则 (Issue !155)
#
# 背景：rd-auto/scripts/lib/*.js 使用 ESM (import/export) 但缺 package.json，
# Node 20 LTS 把 .js 视为 CommonJS，运行时报 SyntaxError。
# 本测试覆盖 setup-harness.sh --check 新增的防御性自检规则：
#   1) PASS: 目录有 ESM js + 有 package.json 含 type:module → 不报错
#   2) PASS: 目录无 ESM js + 无 package.json → 不报错（其他 skill 现状）
#   3) FAIL: 目录有 ESM js + 无 package.json（或缺 type:module）→ 报 RED
#
# 测试用临时目录造场景，不污染源仓库。
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

# 从 setup-harness.sh 抽取 check_esm_scripts_type_module 函数 + 辅助（颜色/info/warn/error）
extract_function() {
    local fn="$1"
    local file="$2"
    sed -n "/^${fn}()/,/^}$/p" "$file"
}

AUX_FUNCS=$(sed -n '/^GREEN=/,/^section()/p' "${SETUP_SH}")
CHECK_FUNC=$(extract_function "check_esm_scripts_type_module" "${SETUP_SH}")

if [ -z "${CHECK_FUNC}" ]; then
    echo "FAIL: check_esm_scripts_type_module 函数未在 setup-harness.sh 中定义"
    exit 1
fi

HELPER="${SCRIPT_DIR}/.esm-type-check-helper.tmp.sh"
{
    echo "#!/usr/bin/env bash"
    echo "set -uo pipefail"
    echo "${AUX_FUNCS}"
    echo ""
    echo "${CHECK_FUNC}"
} > "${HELPER}"
CLEANUP_DIRS="${CLEANUP_DIRS} ${HELPER}"

echo "check_esm_scripts_type_module tests (Issue !155)"
echo "================================================"

# ─── case 1: PASS — 有 ESM js + 有 package.json 含 type:module ───
T1="$(mktemp -d)"
CLEANUP_DIRS="${CLEANUP_DIRS} ${T1}"
SKILL1="${T1}/.claude/skills/my-skill/scripts"
mkdir -p "${SKILL1}/lib"
cat > "${SKILL1}/lib/helper.js" <<'EOF'
export function foo() { return 1; }
import { bar } from 'node:fs';
EOF
echo '{"type":"module"}' > "${SKILL1}/package.json"

OUT1=$(source "${HELPER}"; check_esm_scripts_type_module "${T1}" 2>&1) || true
# 断言: 不报 RED（不应出现 ✗ RED 颜色码 \033[0;31m + ✗）
if echo "${OUT1}" | grep -q $'\033\[0;31m'"✗"; then
    echo "  case 1 (ESM + type:module → PASS): FAIL — 误报 RED"
    echo "    output: ${OUT1}"
    FAIL=$((FAIL + 1))
else
    echo "  case 1 (ESM + type:module → PASS): PASS"
    PASS=$((PASS + 1))
fi

# ─── case 2: PASS — 无 ESM js + 无 package.json（其他 skill 现状） ───
T2="$(mktemp -d)"
CLEANUP_DIRS="${CLEANUP_DIRS} ${T2}"
SKILL2="${T2}/.claude/skills/other-skill/scripts"
mkdir -p "${SKILL2}/lib"
cat > "${SKILL2}/lib/helper.js" <<'EOF'
const fs = require('node:fs');
module.exports = { foo: 1 };
EOF
# 无 package.json

OUT2=$(source "${HELPER}"; check_esm_scripts_type_module "${T2}" 2>&1) || true
if echo "${OUT2}" | grep -q $'\033\[0;31m'"✗"; then
    echo "  case 2 (无 ESM + 无 pkg → PASS): FAIL — 误报 RED"
    echo "    output: ${OUT2}"
    FAIL=$((FAIL + 1))
else
    echo "  case 2 (无 ESM + 无 pkg → PASS): PASS"
    PASS=$((PASS + 1))
fi

# ─── case 3: FAIL — 有 ESM js + 无 package.json ───
T3="$(mktemp -d)"
CLEANUP_DIRS="${CLEANUP_DIRS} ${T3}"
SKILL3="${T3}/.claude/skills/broken-skill/scripts"
mkdir -p "${SKILL3}/lib"
cat > "${SKILL3}/lib/helper.js" <<'EOF'
export const x = 1;
EOF
# 无 package.json

OUT3=$(source "${HELPER}"; check_esm_scripts_type_module "${T3}" 2>&1) || true
# 断言 1: 报 RED
if echo "${OUT3}" | grep -q $'\033\[0;31m'"✗"; then
    echo "  case 3 (ESM + 无 pkg → RED): PASS"
    PASS=$((PASS + 1))
else
    echo "  case 3 (ESM + 无 pkg → RED): FAIL — 未报 RED"
    echo "    output: ${OUT3}"
    FAIL=$((FAIL + 1))
fi
# 断言 2: 指出具体目录
if echo "${OUT3}" | grep -q "broken-skill/scripts"; then
    echo "  case 3 (指出具体目录): PASS"
    PASS=$((PASS + 1))
else
    echo "  case 3 (指出具体目录): FAIL"
    FAIL=$((FAIL + 1))
fi
# 断言 3: 提示修复方式（含 type:module 关键字）
if echo "${OUT3}" | grep -q "type.*module"; then
    echo "  case 3 (提示修复方式): PASS"
    PASS=$((PASS + 1))
else
    echo "  case 3 (提示修复方式): FAIL — 未含 type:module 提示"
    FAIL=$((FAIL + 1))
fi

# ─── case 4: FAIL — 有 ESM js + 有 package.json 但缺 type:module ───
T4="$(mktemp -d)"
CLEANUP_DIRS="${CLEANUP_DIRS} ${T4}"
SKILL4="${T4}/.claude/skills/wrong-pkg/scripts"
mkdir -p "${T4}/.claude/skills/wrong-pkg/scripts/lib"
cat > "${T4}/.claude/skills/wrong-pkg/scripts/lib/helper.js" <<'EOF'
import { x } from 'node:path';
export default x;
EOF
# package.json 存在但不含 type:module
echo '{"name":"wrong","dependencies":{"ajv":"^8.0.0"}}' > "${T4}/.claude/skills/wrong-pkg/scripts/package.json"

OUT4=$(source "${HELPER}"; check_esm_scripts_type_module "${T4}" 2>&1) || true
if echo "${OUT4}" | grep -q $'\033\[0;31m'"✗"; then
    echo "  case 4 (ESM + pkg 缺 type:module → RED): PASS"
    PASS=$((PASS + 1))
else
    echo "  case 4 (ESM + pkg 缺 type:module → RED): FAIL — 未报 RED"
    echo "    output: ${OUT4}"
    FAIL=$((FAIL + 1))
fi

# ─── case 5: 容错 — package.json 中 "type" 字段带空格/单引号也算合法 ───
T5="$(mktemp -d)"
CLEANUP_DIRS="${CLEANUP_DIRS} ${T5}"
SKILL5="${T5}/.claude/skills/flex-skill/scripts"
mkdir -p "${T5}/.claude/skills/flex-skill/scripts/lib"
cat > "${T5}/.claude/skills/flex-skill/scripts/lib/helper.js" <<'EOF'
export const y = 2;
EOF
# package.json 含 "type" : "module"（带空格）
printf '{\n  "name": "flex",\n  "type"  :  "module"\n}\n' > "${T5}/.claude/skills/flex-skill/scripts/package.json"

OUT5=$(source "${HELPER}"; check_esm_scripts_type_module "${T5}" 2>&1) || true
if echo "${OUT5}" | grep -q $'\033\[0;31m'"✗"; then
    echo "  case 5 (type:module 容错空格 → PASS): FAIL — 误报 RED"
    echo "    output: ${OUT5}"
    FAIL=$((FAIL + 1))
else
    echo "  case 5 (type:module 容错空格 → PASS): PASS"
    PASS=$((PASS + 1))
fi

# ─── case 6: 多 skill 混合 — 一个 PASS 一个 FAIL，输出含 FAIL 目录 ───
T6="$(mktemp -d)"
CLEANUP_DIRS="${CLEANUP_DIRS} ${T6}"
mkdir -p "${T6}/.claude/skills/ok-skill/scripts/lib" "${T6}/.claude/skills/bad-skill/scripts/lib"
echo 'export const a = 1;' > "${T6}/.claude/skills/ok-skill/scripts/lib/h.js"
echo '{"type":"module"}' > "${T6}/.claude/skills/ok-skill/scripts/package.json"
echo 'export const b = 2;' > "${T6}/.claude/skills/bad-skill/scripts/lib/h.js"
# bad-skill 无 package.json

OUT6=$(source "${HELPER}"; check_esm_scripts_type_module "${T6}" 2>&1) || true
if echo "${OUT6}" | grep -q "bad-skill" && echo "${OUT6}" | grep -q $'\033\[0;31m'"✗"; then
    if ! echo "${OUT6}" | grep -q "ok-skill/scripts.*✗"; then
        echo "  case 6 (多 skill 混合 → 仅报 bad): PASS"
        PASS=$((PASS + 1))
    else
        echo "  case 6 (多 skill 混合 → 仅报 bad): FAIL — ok-skill 被误报"
        echo "    output: ${OUT6}"
        FAIL=$((FAIL + 1))
    fi
else
    echo "  case 6 (多 skill 混合 → 仅报 bad): FAIL — 未正确报 bad-skill"
    echo "    output: ${OUT6}"
    FAIL=$((FAIL + 1))
fi

# ─── case 7: python3 不可用 + pkg 有 type:module → PASS（grep 兜底命中） ───
T7="$(mktemp -d)"
CLEANUP_DIRS="${CLEANUP_DIRS} ${T7}"
SKILL7="${T7}/.claude/skills/no-py3-ok/scripts"
mkdir -p "${SKILL7}/lib"
cat > "${SKILL7}/lib/helper.js" <<'EOF'
export const z = 3;
EOF
echo '{"type":"module"}' > "${SKILL7}/package.json"

# mock 掉 python3（让 python3 命令退 127），模拟系统未装 python3
OUT7=$(source "${HELPER}"; python3() { return 127; }; check_esm_scripts_type_module "${T7}" 2>&1) || true
if echo "${OUT7}" | grep -q $'\033\[0;31m'"✗"; then
    echo "  case 7 (无 python3 + pkg 有 type:module → PASS): FAIL — grep 兜底未命中，误报 RED"
    echo "    output: ${OUT7}"
    FAIL=$((FAIL + 1))
else
    echo "  case 7 (无 python3 + pkg 有 type:module → PASS): PASS"
    PASS=$((PASS + 1))
fi

# ─── case 8: python3 不可用 + pkg 无 type:module → 仍报 RED（兜底不掩盖违规） ───
T8="$(mktemp -d)"
CLEANUP_DIRS="${CLEANUP_DIRS} ${T8}"
SKILL8="${T8}/.claude/skills/no-py3-bad/scripts"
mkdir -p "${SKILL8}/lib"
cat > "${SKILL8}/lib/helper.js" <<'EOF'
export const w = 4;
EOF
# package.json 存在但无 type:module
echo '{"name":"no-module"}' > "${SKILL8}/package.json"

OUT8=$(source "${HELPER}"; python3() { return 127; }; check_esm_scripts_type_module "${T8}" 2>&1) || true
if echo "${OUT8}" | grep -q $'\033\[0;31m'"✗"; then
    echo "  case 8 (无 python3 + pkg 无 type:module → RED): PASS"
    PASS=$((PASS + 1))
else
    echo "  case 8 (无 python3 + pkg 无 type:module → RED): FAIL — 兜底掩盖了真实违规"
    echo "    output: ${OUT8}"
    FAIL=$((FAIL + 1))
fi

echo "================================================"
echo "Results: ${PASS} passed, ${FAIL} failed"
if [ "${FAIL}" -gt 0 ]; then
    exit 1
fi
exit 0
