#!/usr/bin/env bash
# Test: doctor.sh 健康自检（只读检查，不自动修复）
#
# Covers:
#   - 仓库自身体检全 PASS，exit 0
#   - 版本签名被篡改 → FAIL，exit 1
#   - settings.json 损坏 → FAIL，exit 1
#   - backend 感知（Issue !260）：codex / zcode 的配置+hooks 文件名从 targets.json 解析，
#     不再硬编码 settings.json；产物齐全 → PASS，hooks 损坏/缺失 → FAIL
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR"/../../../.. && pwd)"
DOCTOR="$PROJECT_ROOT/.claude/tools/scripts/maintenance/doctor.sh"

PASS=0
FAIL=0

ok()   { echo "  [PASS] $1"; PASS=$((PASS + 1)); }
bad()  { echo "  [FAIL] $1"; FAIL=$((FAIL + 1)); }

BASE_TMP="$(mktemp -d)"
trap 'rm -rf "$BASE_TMP"' EXIT

# harness-version 签名：sha256(version + "rd-harness-v2") 前 8 位（与 doctor.sh 同算法）
harness_sig() {
    printf '%s' "${1}rd-harness-v2" \
      | { command -v sha256sum >/dev/null 2>&1 && sha256sum || shasum -a 256; } 2>/dev/null \
      | grep -oE '[0-9a-f]{64}' | head -1 | cut -c1-8
}

write_version_file() { # write_version_file <path> <version>
    printf '%s\n\n%s\n' "$2" "$(harness_sig "$2")" > "$1"
}

# 造一个"最小可通过"的假仓：backend 目录为 $2（.claude / .codex / .zcode ...）。
# 覆盖 doctor 检查 2/4/5/6 所需的全部制品；检查 3 的配置/hooks 文件由各用例自行写入。
build_fixture() { # build_fixture <root> <backend_dir>
    local root="$1" bdir="$2"
    mkdir -p "$root/.harness" \
             "$root/$bdir/skills/rd-auto/scripts/lib" \
             "$root/$bdir/reference" \
             "$root/.claude/tools/scripts/generate"
    cp "$PROJECT_ROOT/.claude/skills/rd-auto/scripts/lib/"*.js "$root/$bdir/skills/rd-auto/scripts/lib/"
    cp "$PROJECT_ROOT/.claude/skills/rd-auto/scripts/orchestrator.js" "$root/$bdir/skills/rd-auto/scripts/"
    cp "$PROJECT_ROOT/.claude/skills/rd-auto/scripts/package.json" "$root/$bdir/skills/rd-auto/scripts/" \
      2>/dev/null || echo '{"type":"module"}' > "$root/$bdir/skills/rd-auto/scripts/package.json"
    cp "$PROJECT_ROOT/.claude/skills/rd-auto/SKILL.md" "$root/$bdir/skills/rd-auto/SKILL.md"
    cp "$PROJECT_ROOT/.claude/reference/harness-rules.yaml" "$root/$bdir/reference/"
    # targets.json 随 manifest 分发到每个业务仓的 .claude/（generator 不复制到 backend 目录）
    cp "$PROJECT_ROOT/.claude/tools/scripts/generate/targets.json" \
       "$root/.claude/tools/scripts/generate/targets.json"
    write_version_file "$root/.harness/.harness-version" "1.25.0"
    if [ "$bdir" != ".claude" ]; then
        git -C "$root" init -q
        git -C "$root" config harness.backend-dir "$bdir"
    fi
}

# 任意 backend 都合法的 hooks 载荷（claude/codebuddy/qoder/zcode/codex 均为 hooks.PreToolUse 数组）
HOOKS_JSON='{"hooks":{"PreToolUse":[{"matcher":"^Bash$","hooks":[{"type":"command","command":"true"}]}]}}'

echo "=== doctor.sh tests ==="
echo ""

# T1: 仓库自身体检 exit 0 且无 FAIL 行
echo "T1: doctor on repo root passes"
OUT="$(bash "$DOCTOR" 2>&1)" || true
if echo "$OUT" | grep -q "FAIL" || ! bash "$DOCTOR" >/dev/null 2>&1; then
    echo "  [FAIL] doctor reports failures on the repo itself:"
    echo "$OUT" | grep "FAIL" | sed 's/^/    /'
    FAIL=$((FAIL + 1))
else
    ok "doctor clean on repo root"
fi
echo ""

# T2: 版本签名篡改 → FAIL + exit 1
echo "T2: tampered version signature fails"
TMPDIR_TEST="$BASE_TMP/claude-backend"
build_fixture "$TMPDIR_TEST" ".claude"
printf '1.99.0\n\ndeadbeef\n' > "$TMPDIR_TEST/.harness/.harness-version"
# 空 settings.json（合法 JSON 但无 hooks）也应触发 hooks 检查 FAIL——本测试聚焦版本签名
echo '{}' > "$TMPDIR_TEST/.claude/settings.json"

if bash "$DOCTOR" "$TMPDIR_TEST" >/dev/null 2>&1; then
    bad "doctor exits 0 on tampered signature"
else
    OUT2="$(bash "$DOCTOR" "$TMPDIR_TEST" 2>&1 || true)"
    if echo "$OUT2" | grep -q "harness-version"; then
        ok "tampered signature detected and reported"
    else
        bad "doctor exits non-zero but does not name harness-version check"
    fi
fi
echo ""

# T3: settings.json 非法 JSON → FAIL
echo "T3: corrupt settings.json fails"
printf '{broken json' > "$TMPDIR_TEST/.claude/settings.json"
write_version_file "$TMPDIR_TEST/.harness/.harness-version" "1.25.0"
OUT3="$(bash "$DOCTOR" "$TMPDIR_TEST" 2>&1 || true)"
if bash "$DOCTOR" "$TMPDIR_TEST" >/dev/null 2>&1; then
    bad "doctor exits 0 on corrupt settings.json"
elif echo "$OUT3" | grep -q "settings.json"; then
    ok "corrupt settings.json detected"
else
    bad "doctor exits non-zero but does not name .claude/settings.json"
fi
echo ""

# T4: codex backend 产物齐全 → 全 PASS + exit 0（Issue !260 回归）
echo "T4: codex backend with complete artifacts passes"
CODEX_ROOT="$BASE_TMP/codex-backend"
build_fixture "$CODEX_ROOT" ".codex"
printf 'approval_policy = "never"\n' > "$CODEX_ROOT/.codex/config.toml"
printf '%s\n' "$HOOKS_JSON" > "$CODEX_ROOT/.codex/hooks.json"
OUT4="$(bash "$DOCTOR" "$CODEX_ROOT" 2>&1 || true)"
if ! bash "$DOCTOR" "$CODEX_ROOT" >/dev/null 2>&1; then
    bad "doctor fails on a healthy codex-backend project:"
    echo "$OUT4" | grep "FAIL" | sed 's/^/    /'
elif echo "$OUT4" | grep -q "settings.json"; then
    bad "doctor still mentions settings.json under codex backend:"
    echo "$OUT4" | grep "settings.json" | sed 's/^/    /'
elif ! echo "$OUT4" | grep -q "\.codex/hooks\.json"; then
    bad "check name does not carry the real hooks file (.codex/hooks.json)"
else
    ok "codex backend clean, check names .codex/hooks.json"
fi
echo ""

# T5: codex hooks.json 非法 JSON → FAIL
echo "T5: codex corrupt hooks.json fails"
printf '{broken' > "$CODEX_ROOT/.codex/hooks.json"
OUT5="$(bash "$DOCTOR" "$CODEX_ROOT" 2>&1 || true)"
if bash "$DOCTOR" "$CODEX_ROOT" >/dev/null 2>&1; then
    bad "doctor exits 0 on corrupt .codex/hooks.json"
elif ! echo "$OUT5" | grep -q "\.codex/hooks\.json"; then
    bad "FAIL message does not name .codex/hooks.json"
else
    ok "corrupt .codex/hooks.json detected and named"
fi
echo ""

# T6: codex config.toml 缺失 → FAIL（不能因为文件名不是 settings.json 就漏检）
echo "T6: codex missing config.toml fails"
printf '%s\n' "$HOOKS_JSON" > "$CODEX_ROOT/.codex/hooks.json"
rm -f "$CODEX_ROOT/.codex/config.toml"
OUT6="$(bash "$DOCTOR" "$CODEX_ROOT" 2>&1 || true)"
if bash "$DOCTOR" "$CODEX_ROOT" >/dev/null 2>&1; then
    bad "doctor exits 0 with .codex/config.toml missing"
elif ! echo "$OUT6" | grep -q "\.codex/config\.toml"; then
    bad "FAIL message does not name .codex/config.toml"
else
    ok "missing .codex/config.toml detected and named"
fi
echo ""

# T7: zcode backend 产物齐全 → 全 PASS + exit 0
echo "T7: zcode backend with complete artifacts passes"
ZCODE_ROOT="$BASE_TMP/zcode-backend"
build_fixture "$ZCODE_ROOT" ".zcode"
mkdir -p "$ZCODE_ROOT/.zcode/.zcode-plugin" "$ZCODE_ROOT/.zcode/hooks"
printf '{"name":"uni-auri","skills":"skills","agents":"agents"}\n' > "$ZCODE_ROOT/.zcode/.zcode-plugin/plugin.json"
printf '%s\n' "$HOOKS_JSON" > "$ZCODE_ROOT/.zcode/hooks/hooks.json"
OUT7="$(bash "$DOCTOR" "$ZCODE_ROOT" 2>&1 || true)"
if ! bash "$DOCTOR" "$ZCODE_ROOT" >/dev/null 2>&1; then
    bad "doctor fails on a healthy zcode-backend project:"
    echo "$OUT7" | grep "FAIL" | sed 's/^/    /'
elif echo "$OUT7" | grep -q "settings.json"; then
    bad "doctor still mentions settings.json under zcode backend:"
    echo "$OUT7" | grep "settings.json" | sed 's/^/    /'
elif ! echo "$OUT7" | grep -q "\.zcode/hooks/hooks\.json"; then
    bad "check name does not carry the real hooks file (.zcode/hooks/hooks.json)"
else
    ok "zcode backend clean, check names .zcode/hooks/hooks.json"
fi
echo ""

# T8: zcode hooks.json 缺失 → FAIL
echo "T8: zcode missing hooks.json fails"
rm -f "$ZCODE_ROOT/.zcode/hooks/hooks.json"
OUT8="$(bash "$DOCTOR" "$ZCODE_ROOT" 2>&1 || true)"
if bash "$DOCTOR" "$ZCODE_ROOT" >/dev/null 2>&1; then
    bad "doctor exits 0 with .zcode/hooks/hooks.json missing"
elif ! echo "$OUT8" | grep -q "\.zcode/hooks/hooks\.json"; then
    bad "FAIL message does not name .zcode/hooks/hooks.json"
else
    ok "missing .zcode/hooks/hooks.json detected and named"
fi
echo ""

# T9: zcode hooks 为空数组 → FAIL（可解析但 PreToolUse 未注册）
echo "T9: zcode empty PreToolUse fails"
printf '{"hooks":{"PreToolUse":[]}}\n' > "$ZCODE_ROOT/.zcode/hooks/hooks.json"
if bash "$DOCTOR" "$ZCODE_ROOT" >/dev/null 2>&1; then
    bad "doctor exits 0 with empty hooks.PreToolUse"
else
    ok "empty hooks.PreToolUse detected"
fi
echo ""

# T10: 结构约束——backend→文件名不得在 doctor.sh 里写死 case 表，必须读 targets.json
echo "T10: doctor.sh reads targets.json, no hardcoded backend names"
CODE_ONLY="$(grep -vE '^[[:space:]]*#' "$DOCTOR" || true)"
if ! echo "$CODE_ONLY" | grep -q "targets.json"; then
    bad "doctor.sh does not reference targets.json"
elif echo "$CODE_ONLY" | grep -qE '\.?(codex|zcode|codebuddy|qoder)'; then
    bad "doctor.sh hardcodes backend names in code:"
    echo "$CODE_ONLY" | grep -nE '\.?(codex|zcode|codebuddy|qoder)' | sed 's/^/    /'
else
    ok "doctor.sh resolves backend layout from targets.json only"
fi
echo ""

# T11: targets.json 全仓缺失 → 报"无法定位 targets.json"，而不是谎报缺 settings.json
echo "T11: missing targets.json reports the real cause"
NT_ROOT="$BASE_TMP/no-targets"
build_fixture "$NT_ROOT" ".codex"
printf 'approval_policy = "never"\n' > "$NT_ROOT/.codex/config.toml"
printf '%s\n' "$HOOKS_JSON" > "$NT_ROOT/.codex/hooks.json"
rm -rf "$NT_ROOT/.claude/tools"
# 跑 backend 目录内的 doctor 副本（真实安装形态），使脚本同级 generate/ 兜底也落空
mkdir -p "$NT_ROOT/.codex/tools/scripts/maintenance"
cp "$DOCTOR" "$NT_ROOT/.codex/tools/scripts/maintenance/doctor.sh"
OUT11="$(bash "$NT_ROOT/.codex/tools/scripts/maintenance/doctor.sh" "$NT_ROOT" 2>&1 || true)"
if bash "$NT_ROOT/.codex/tools/scripts/maintenance/doctor.sh" "$NT_ROOT" >/dev/null 2>&1; then
    bad "doctor exits 0 with targets.json missing"
elif echo "$OUT11" | grep -q "settings.json"; then
    bad "doctor blames settings.json instead of the missing targets.json"
elif ! echo "$OUT11" | grep -q "targets.json"; then
    bad "FAIL message does not name targets.json"
else
    ok "missing targets.json reported as the real cause"
fi
echo ""

echo "Result: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
