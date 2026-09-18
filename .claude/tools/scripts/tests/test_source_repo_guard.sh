#!/usr/bin/env bash
# test_source_repo_guard.sh — 框架源仓库守护验证 (install-source-repo-guard)
#
# 验证 5 个守护点 + is_framework_source_repo() 检测函数：
#   D1: is_framework_source_repo() 双信号检测（4 spec 场景）
#   A : install.sh finalize_backend 不含 rm -rf .claude/（Issue !225：删除逻辑已移除）
#   B : do_install 跳过 ensure_gitignore（结构）
#   C : do_install 跳过 install_skill_deps（结构）
#   D : do_install 跳过 untrack_harness_version_if_needed（结构）
#   E : merge_gitignore 入口短路（行为：源仓不合并模板；业务仓仍合并）
#   SYNC: .codex 副本与 .claude 版本一致
#
# 业务仓库回归：检测函数对业务仓恒 false → 守护点不触发 → 原行为不变

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"

INSTALL_SH="$PROJECT_ROOT/install.sh"
SETUP_SH="$PROJECT_ROOT/.claude/tools/scripts/setup/setup-harness.sh"
CODEX_SETUP_SH="$PROJECT_ROOT/.codex/tools/scripts/setup/setup-harness.sh"

PASS=0
FAIL=0

assert() {
    local label="$1" condition="$2"
    if [ "$condition" = "true" ]; then
        echo "  [PASS] $label"
        PASS=$((PASS+1))
    else
        echo "  [FAIL] $label"
        FAIL=$((FAIL+1))
    fi
}

CLEANUP_DIRS=""
cleanup() {
    for d in ${CLEANUP_DIRS}; do
        rm -rf "${d}" 2>/dev/null || true
    done
}
trap cleanup EXIT

# 从 install.sh 提取单个函数定义（从函数签名行到首个列 1 的 `}`）
extract_install_func() {
    local fname="$1" file="$2"
    awk -v fn="$fname" '
        $0 ~ "^" fn "\\(\\) \\{" { p=1 }
        p { print }
        p && /^}/ { exit }
    ' "$file"
}

# ============================================================
# D0: 语法检查
# ============================================================
test_syntax() {
    echo "=== D0: 语法检查 ==="
    assert "install.sh 语法正确" \
           "$(bash -n "$INSTALL_SH" 2>&1 && echo true || echo false)"
    assert "setup-harness.sh (.claude) 语法正确" \
           "$(bash -n "$SETUP_SH" 2>&1 && echo true || echo false)"
    assert "setup-harness.sh (.codex) 语法正确" \
           "$(bash -n "$CODEX_SETUP_SH" 2>&1 && echo true || echo false)"
}

# ============================================================
# D1: is_framework_source_repo() 检测函数（setup-harness.sh 侧）
# ============================================================
test_detection_setup() {
    echo "=== D1: is_framework_source_repo() (setup-harness.sh) ==="

    # 提取 setup-harness.sh 全部函数（入口标记前）
    local funcs; funcs="$(mktemp)"; CLEANUP_DIRS="$CLEANUP_DIRS $funcs"
    awk '/^# ── 入口/{exit} {print}' "$SETUP_SH" > "$funcs"

    # 函数存在性
    assert "setup-harness.sh 定义了 is_framework_source_repo()" \
           "$(grep -q '^is_framework_source_repo()' "$funcs" && echo true || echo false)"

    # 场景 1: 源仓库（install.sh 存在 + git 跟踪）→ true
    local src; src="$(mktemp -d)"; CLEANUP_DIRS="$CLEANUP_DIRS $src"
    git init -q "$src"
    git -C "$src" config user.email "t@t.local"; git -C "$src" config user.name "t"
    git -C "$src" config commit.gpgsign false
    echo "# bootstrap" > "$src/install.sh"
    git -C "$src" add install.sh && git -C "$src" commit -qm add

    # source 函数（屏蔽 do_install 等的真实执行——只测纯函数）
    local det
    det=$(bash -c "source '$funcs'; is_framework_source_repo '$src' && echo true || echo false" 2>/dev/null)
    assert "源仓库（install.sh 存在+tracked）→ true" "$([ "$det" = "true" ] && echo true || echo false)"

    # 场景 2: 业务仓库（无 install.sh）→ false
    local biz; biz="$(mktemp -d)"; CLEANUP_DIRS="$CLEANUP_DIRS $biz"
    git init -q "$biz"
    git -C "$biz" config user.email "t@t.local"; git -C "$biz" config user.name "t"
    echo "# project" > "$biz/README.md"
    git -C "$biz" add README.md && git -C "$biz" commit -qm init
    det=$(bash -c "source '$funcs'; is_framework_source_repo '$biz' && echo true || echo false" 2>/dev/null)
    assert "业务仓库（无 install.sh）→ false" "$([ "$det" = "false" ] && echo true || echo false)"

    # 场景 3: 有 install.sh 但未跟踪 → false
    local unt; unt="$(mktemp -d)"; CLEANUP_DIRS="$CLEANUP_DIRS $unt"
    git init -q "$unt"
    git -C "$unt" config user.email "t@t.local"; git -C "$unt" config user.name "t"
    echo "# untracked" > "$unt/install.sh"
    git -C "$unt" add -A && git -C "$unt" commit -qm init  # install.sh 已提交？是 → tracked
    # 改为 untracked：rm cached
    git -C "$unt" rm --cached install.sh >/dev/null 2>&1 && git -C "$unt" commit -qm unt || true
    # 现在工作区有 install.sh 但索引/HEAD 无
    det=$(bash -c "source '$funcs'; is_framework_source_repo '$unt' && echo true || echo false" 2>/dev/null)
    assert "业务仓库（install.sh 存在但 untracked）→ false" "$([ "$det" = "false" ] && echo true || echo false)"

    # 场景 4: 非 git 仓库 → false
    local ngit; ngit="$(mktemp -d)"; CLEANUP_DIRS="$CLEANUP_DIRS $ngit"
    echo "# bootstrap" > "$ngit/install.sh"
    det=$(bash -c "source '$funcs'; is_framework_source_repo '$ngit' && echo true || echo false" 2>/dev/null)
    assert "非 git 仓库 → false" "$([ "$det" = "false" ] && echo true || echo false)"
}

# ============================================================
# D1b: is_framework_source_repo() 检测函数（install.sh 侧）
# ============================================================
test_detection_install() {
    echo "=== D1b: is_framework_source_repo() (install.sh) ==="

    local funcs; funcs="$(mktemp)"; CLEANUP_DIRS="$CLEANUP_DIRS $funcs"
    extract_install_func "is_framework_source_repo" "$INSTALL_SH" > "$funcs"

    assert "install.sh 定义了 is_framework_source_repo()" \
           "$(grep -q '^is_framework_source_repo()' "$funcs" && echo true || echo false)"

    # 复用 D1 的源仓库 fixture
    local src; src="$(mktemp -d)"; CLEANUP_DIRS="$CLEANUP_DIRS $src"
    git init -q "$src"
    git -C "$src" config user.email "t@t.local"; git -C "$src" config user.name "t"
    git -C "$src" config commit.gpgsign false
    echo "# bootstrap" > "$src/install.sh"
    git -C "$src" add install.sh && git -C "$src" commit -qm add

    local det
    det=$(bash -c "source '$funcs'; is_framework_source_repo '$src' && echo true || echo false" 2>/dev/null)
    assert "install.sh 函数：源仓库 → true" "$([ "$det" = "true" ] && echo true || echo false)"

    local biz; biz="$(mktemp -d)"; CLEANUP_DIRS="$CLEANUP_DIRS $biz"
    det=$(bash -c "source '$funcs'; is_framework_source_repo '$biz' && echo true || echo false" 2>/dev/null)
    assert "install.sh 函数：业务仓库（无 install.sh）→ false" "$([ "$det" = "false" ] && echo true || echo false)"
}

# ============================================================
# E: merge_gitignore 行为 — 源仓短路 / 业务仓合并
# ============================================================
test_merge_gitignore_guard() {
    echo "=== E: merge_gitignore 源仓短路 + 业务仓回归 ==="

    local funcs; funcs="$(mktemp)"; CLEANUP_DIRS="$CLEANUP_DIRS $funcs"
    awk '/^# ── 入口/{exit} {print}' "$SETUP_SH" > "$funcs"

    # 准备一个假 source（带 gitignore.harness 模板）
    local fsrc; fsrc="$(mktemp -d)"; CLEANUP_DIRS="$CLEANUP_DIRS $fsrc"
    mkdir -p "$fsrc/.claude/templates"
    printf ".claude/\n.framework-manifest\n.harness/.harness-version\n" > "$fsrc/.claude/templates/gitignore.harness"

    # --- 源仓场景：merge_gitignore 不应修改 .gitignore ---
    local srepo; srepo="$(mktemp -d)"; CLEANUP_DIRS="$CLEANUP_DIRS $srepo"
    git init -q "$srepo"
    git -C "$srepo" config user.email "t@t.local"; git -C "$srepo" config user.name "t"
    git -C "$srepo" config commit.gpgsign false
    echo "# bootstrap" > "$srepo/install.sh"
    printf "node_modules/\n" > "$srepo/.gitignore"
    git -C "$srepo" add install.sh .gitignore && git -C "$srepo" commit -qm init
    local gi_before; gi_before="$(cat "$srepo/.gitignore")"

    bash -c "source '$funcs'; merge_gitignore '$fsrc' '$srepo'" >/dev/null 2>&1 || true
    local gi_after; gi_after="$(cat "$srepo/.gitignore")"

    assert "源仓：.gitignore 未被注入 .claude/ 规则" \
           "$(! grep -qxF '.claude/' "$srepo/.gitignore" && echo true || echo false)"
    assert "源仓：.gitignore 未被注入 .framework-manifest 规则" \
           "$(! grep -qxF '.framework-manifest' "$srepo/.gitignore" && echo true || echo false)"
    assert "源仓：merge_gitignore 调用后 .gitignore 内容不变" \
           "$([ "$gi_before" = "$gi_after" ] && echo true || echo false)"

    # --- 业务仓场景：merge_gitignore 应合并模板（回归）---
    local brepo; brepo="$(mktemp -d)"; CLEANUP_DIRS="$CLEANUP_DIRS $brepo"
    git init -q "$brepo"
    git -C "$brepo" config user.email "t@t.local"; git -C "$brepo" config user.name "t"
    printf "node_modules/\n" > "$brepo/.gitignore"
    git -C "$brepo" add .gitignore && git -C "$brepo" commit -qm init

    bash -c "source '$funcs'; merge_gitignore '$fsrc' '$brepo'" >/dev/null 2>&1 || true
    assert "业务仓：merge_gitignore 仍合并模板（.claude/ 注入）" \
           "$(grep -qxF '.claude/' "$brepo/.gitignore" && echo true || echo false)"
    assert "业务仓：merge_gitignore 仍合并模板（.framework-manifest 注入）" \
           "$(grep -qxF '.framework-manifest' "$brepo/.gitignore" && echo true || echo false)"
}

# ============================================================
# A/B/C/D: 守护点结构检查（短路条件存在于代码中）
# ============================================================
test_guard_structure() {
    echo "=== A/B/C/D: 守护点结构检查 ==="

    # 守护点 E：merge_gitignore 入口短路（两份脚本）
    assert "E(.claude): merge_gitignore 入口含 is_framework_source_repo 短路" \
           "$(awk '/^merge_gitignore\(\) \{/{f=1} f&&/is_framework_source_repo/{print "true";exit}' "$SETUP_SH" 2>/dev/null)"
    assert "E(.codex): merge_gitignore 入口含 is_framework_source_repo 短路" \
           "$(awk '/^merge_gitignore\(\) \{/{f=1} f&&/is_framework_source_repo/{print "true";exit}' "$CODEX_SETUP_SH" 2>/dev/null)"

    # 守护点 A：install.sh finalize_backend 不含 rm -rf .claude/（Issue !225）
    # 旧语义是"删除前用 is_framework_source_repo 守护"（断言守护存在），
    # 新语义是"根本不删除"——断言翻转：finalize_backend 函数体内不得出现 rm -rf "$target/.claude/"。
    local finalize_body
    finalize_body=$(awk '/^finalize_backend\(\) \{/{f=1} f{print} f&&/^}/{exit}' "$INSTALL_SH")
    assert "A: install.sh finalize_backend 不含 rm -rf .claude/（删除已移除）" \
           "$([[ "$finalize_body" != *'rm -rf "$target/.claude/'* ]] && echo true || echo false)"

    # 守护点 B/C/D：do_install 内 IS_SOURCE_REPO 条件守护（.claude）
    # do_install 开头检测 IS_SOURCE_REPO；ensure_gitignore/install_skill_deps/untrack 被 IS_SOURCE_REPO 守护
    local do_install_block
    do_install_block=$(awk '/^do_install\(\) \{/{f=1} f{print} f&&/^}/{exit}' "$SETUP_SH")

    assert "B/C/D(.claude): do_install 检测 IS_SOURCE_REPO 变量" \
           "$(echo "$do_install_block" | grep -q 'IS_SOURCE_REPO' && echo true || echo false)"
    assert "B(.claude): ensure_gitignore 被 IS_SOURCE_REPO 守护" \
           "$(echo "$do_install_block" | grep -qE 'IS_SOURCE_REPO.*=.*"1".*\|\| *ensure_gitignore|ensure_gitignore.*IS_SOURCE_REPO' && echo true || echo false)"
    assert "C(.claude): install_skill_deps 被 IS_SOURCE_REPO 守护" \
           "$(echo "$do_install_block" | grep -qE 'IS_SOURCE_REPO.*=.*"1".*\|\| *install_skill_deps' && echo true || echo false)"
    assert "D(.claude): untrack_harness_version_if_needed 被 IS_SOURCE_REPO 守护" \
           "$(echo "$do_install_block" | grep -qE 'IS_SOURCE_REPO.*=.*"1".*\|\| *untrack_harness_version' && echo true || echo false)"

    # .codex 副本同样
    local do_install_block_codex
    do_install_block_codex=$(awk '/^do_install\(\) \{/{f=1} f{print} f&&/^}/{exit}' "$CODEX_SETUP_SH")
    assert "B/C/D(.codex): do_install 检测 IS_SOURCE_REPO 变量" \
           "$(echo "$do_install_block_codex" | grep -q 'IS_SOURCE_REPO' && echo true || echo false)"
    assert "B(.codex): ensure_gitignore 被 IS_SOURCE_REPO 守护" \
           "$(echo "$do_install_block_codex" | grep -qE 'IS_SOURCE_REPO.*=.*"1".*\|\| *ensure_gitignore' && echo true || echo false)"
    assert "C(.codex): install_skill_deps 被 IS_SOURCE_REPO 守护" \
           "$(echo "$do_install_block_codex" | grep -qE 'IS_SOURCE_REPO.*=.*"1".*\|\| *install_skill_deps' && echo true || echo false)"
    assert "D(.codex): untrack_harness_version_if_needed 被 IS_SOURCE_REPO 守护" \
           "$(echo "$do_install_block_codex" | grep -qE 'IS_SOURCE_REPO.*=.*"1".*\|\| *untrack_harness_version' && echo true || echo false)"
}

# ============================================================
# SYNC: .codex 副本与 .claude 版本一致（is_framework_source_repo 定义相同）
# ============================================================
test_codex_sync() {
    echo "=== SYNC: .codex 副本一致性 ==="

    local cl_func cx_func
    cl_func=$(awk '/^is_framework_source_repo\(\) \{/{f=1} f{print} f&&/^}/{exit}' "$SETUP_SH")
    cx_func=$(awk '/^is_framework_source_repo\(\) \{/{f=1} f{print} f&&/^}/{exit}' "$CODEX_SETUP_SH")
    assert ".codex 与 .claude 的 is_framework_source_repo 函数体一致" \
           "$([ "$cl_func" = "$cx_func" ] && [ -n "$cl_func" ] && echo true || echo false)"

    assert ".claude 与 .codex 的 merge_gitignore 守护行一致（短路存在性）" \
           "$([ "$(grep -c 'is_framework_source_repo' "$SETUP_SH")" = "$(grep -c 'is_framework_source_repo' "$CODEX_SETUP_SH")" ] && echo true || echo false)"
}

# ============================================================
# 主入口
# ============================================================
echo ""
echo "╔═══════════════════════════════════════════════════════╗"
echo "║  test_source_repo_guard.sh — 框架源仓库守护验证      ║"
echo "╚═══════════════════════════════════════════════════════╝"
echo ""

test_syntax
test_detection_setup
test_detection_install
test_merge_gitignore_guard
test_guard_structure
test_codex_sync

echo ""
echo "════════════════════════════════════════════════════════"
echo "  Results: $PASS passed, $FAIL failed"
echo "════════════════════════════════════════════════════════"

[ "$FAIL" = "0" ] || exit 1
