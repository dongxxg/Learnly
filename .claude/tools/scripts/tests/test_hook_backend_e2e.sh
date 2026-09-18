#!/usr/bin/env bash
# test_hook_backend_e2e.sh — hook 真实触发 E2E (C8 P0 fix verification)
#
# C8 P0: setup-hooks.sh HOOKS_SRC 写死 .claude 导致 codex/codebuddy lite 安装后
# .git/hooks/ 无 trampoline，hook 完全失效。本测试验证 fix（HOOKS_SRC 跟随 backend_dir）
# 通过真实 git commit 触发 hook（不再仅单元级）。
#
# 测试矩阵（design §7.1 AC-1/2/3 + C6 E2E 补缺）:
#   E2E-1 codex lite 安装: trampoline 存在 + 真实 git commit 触发 pre-commit (TDD 阻断)
#   E2E-2 codebuddy lite 安装: 同上
#   E2E-3 claude lite 回归: trampoline 存在 + hook 触发（不破）
#   E2E-4 codex 框架文件保护: stage 框架文件被阻断; .framework-edit 放行
#   E2E-5 standalone setup-hooks.sh 读 config: 无 HARNESS_BACKEND 时读 config 重建 trampoline
#
# 参考: test_hook_backend_dir.sh (单元级) + Tester /tmp/test_e2e_hook_backend.sh (场景)

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR"/../../../.. && pwd)"
SETUP_SH="$PROJECT_ROOT/.claude/tools/scripts/setup/setup-harness.sh"
SETUP_HOOKS_SH="$PROJECT_ROOT/.claude/tools/scripts/setup/setup-hooks.sh"

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

# ── 辅助：创建临时 git 仓库 ──
make_repo() {
    local tmp="$1"
    git init -q "$tmp"
    git -C "$tmp" config user.email "test@test.local"
    git -C "$tmp" config user.name "test"
    git -C "$tmp" config commit.gpgsign false
}

# ── 辅助：提取 setup-harness.sh 函数定义（不含入口点）──
extract_setup_funcs() {
    local out="$1"
    awk '/^# ── 入口/{exit} {print}' "$SETUP_SH" > "$out"
}

# ── 辅助：在子 shell 中运行 do_install_lite ──
# 覆盖 HARNESS_SOURCE 指向源仓根（resolve_source 用它）
run_install_lite() {
    local backend="$1" target="$2"
    local funcs; funcs="$(mktemp)"
    extract_setup_funcs "$funcs"
    (
        cd "$target" || exit 1
        # shellcheck disable=SC1090
        source "$funcs"
        HARNESS_SOURCE="$PROJECT_ROOT"
        export HARNESS_BACKEND="$backend"
        do_install_lite "$target"
    ) >/dev/null 2>&1 || true
    rm -f "$funcs"
}

# ============================================================
# E2E-1: codex lite 安装 — trampoline 存在 + 真实 git commit 触发
# ============================================================
test_codex_e2e() {
    echo "=== E2E-1: codex lite 安装（trampoline + 真实触发）==="
    local tmp; tmp="$(mktemp -d)"
    make_repo "$tmp"

    run_install_lite codex "$tmp"

    local trampoline_marker="Auto-generated hook trampoline"

    # C8 核心: trampoline 必须存在（C8 bug 时这里为空）
    assert "codex: .git/hooks/pre-commit trampoline 存在" \
           "$([ -f "$tmp/.git/hooks/pre-commit" ] && grep -q "$trampoline_marker" "$tmp/.git/hooks/pre-commit" && echo true || echo false)"
    assert "codex: .git/hooks/commit-msg trampoline 存在" \
           "$([ -f "$tmp/.git/hooks/commit-msg" ] && grep -q "$trampoline_marker" "$tmp/.git/hooks/commit-msg" && echo true || echo false)"
    assert "codex: .git/hooks/pre-push trampoline 存在" \
           "$([ -f "$tmp/.git/hooks/pre-push" ] && grep -q "$trampoline_marker" "$tmp/.git/hooks/pre-push" && echo true || echo false)"

    # 真实 git commit 触发 pre-commit（TDD 阻断证明 hook 被调用）
    mkdir -p "$tmp/src"
    echo "print('hello')" > "$tmp/src/main.py"
    git -C "$tmp" add src/main.py
    local commit_out
    commit_out="$(git -C "$tmp" commit -m "[0000] DEV test[AI·Developer]

feat: test codex trigger" 2>&1 || true)"

    # 无测试文件的生产代码 → pre-commit TDD 检查阻断（exit 1）
    # 若 C8 未修（无 trampoline），commit 成功（无 TDD 输出）
    assert "codex: 真实 git commit 触发 pre-commit（TDD 阻断）" \
           "$(echo "$commit_out" | grep -q '\[TDD\]' && echo true || echo false)"

    # 验证 hook 读 config 指向 .codex（TDD 过滤链排除 .codex/）
    local cfg; cfg="$(git -C "$tmp" config harness.backend-dir 2>/dev/null || echo '')"
    assert "codex: config harness.backend-dir = .codex" \
           "$([ "$cfg" = ".codex" ] && echo true || echo false)"

    rm -rf "$tmp"
}

# ============================================================
# E2E-2: codebuddy lite 安装 — trampoline 存在 + 真实 git commit 触发
# ============================================================
test_codebuddy_e2e() {
    echo "=== E2E-2: codebuddy lite 安装（trampoline + 真实触发）==="
    local tmp; tmp="$(mktemp -d)"
    make_repo "$tmp"

    run_install_lite codebuddy "$tmp"

    local trampoline_marker="Auto-generated hook trampoline"

    assert "codebuddy: .git/hooks/pre-commit trampoline 存在" \
           "$([ -f "$tmp/.git/hooks/pre-commit" ] && grep -q "$trampoline_marker" "$tmp/.git/hooks/pre-commit" && echo true || echo false)"
    assert "codebuddy: .git/hooks/commit-msg trampoline 存在" \
           "$([ -f "$tmp/.git/hooks/commit-msg" ] && grep -q "$trampoline_marker" "$tmp/.git/hooks/commit-msg" && echo true || echo false)"
    assert "codebuddy: .git/hooks/pre-push trampoline 存在" \
           "$([ -f "$tmp/.git/hooks/pre-push" ] && grep -q "$trampoline_marker" "$tmp/.git/hooks/pre-push" && echo true || echo false)"

    # 真实 git commit 触发
    mkdir -p "$tmp/src"
    echo "print('hello')" > "$tmp/src/main.py"
    git -C "$tmp" add src/main.py
    local commit_out
    commit_out="$(git -C "$tmp" commit -m "[0000] DEV test[AI·Developer]

feat: test codebuddy trigger" 2>&1 || true)"

    assert "codebuddy: 真实 git commit 触发 pre-commit（TDD 阻断）" \
           "$(echo "$commit_out" | grep -q '\[TDD\]' && echo true || echo false)"

    local cfg; cfg="$(git -C "$tmp" config harness.backend-dir 2>/dev/null || echo '')"
    assert "codebuddy: config harness.backend-dir = .codebuddy" \
           "$([ "$cfg" = ".codebuddy" ] && echo true || echo false)"

    rm -rf "$tmp"
}

# ============================================================
# E2E-3: claude lite 回归 — trampoline 存在 + hook 触发（不破）
# ============================================================
test_claude_e2e() {
    echo "=== E2E-3: claude lite 回归（trampoline + 真实触发）==="
    local tmp; tmp="$(mktemp -d)"
    make_repo "$tmp"

    run_install_lite claude "$tmp"

    local trampoline_marker="Auto-generated hook trampoline"

    assert "claude: .git/hooks/pre-commit trampoline 存在" \
           "$([ -f "$tmp/.git/hooks/pre-commit" ] && grep -q "$trampoline_marker" "$tmp/.git/hooks/pre-commit" && echo true || echo false)"
    assert "claude: .git/hooks/commit-msg trampoline 存在" \
           "$([ -f "$tmp/.git/hooks/commit-msg" ] && grep -q "$trampoline_marker" "$tmp/.git/hooks/commit-msg" && echo true || echo false)"
    assert "claude: .git/hooks/pre-push trampoline 存在" \
           "$([ -f "$tmp/.git/hooks/pre-push" ] && grep -q "$trampoline_marker" "$tmp/.git/hooks/pre-push" && echo true || echo false)"

    # 真实 git commit 触发
    mkdir -p "$tmp/src"
    echo "print('hello')" > "$tmp/src/main.py"
    git -C "$tmp" add src/main.py
    local commit_out
    commit_out="$(git -C "$tmp" commit -m "[0000] DEV test[AI·Developer]

feat: test claude trigger" 2>&1 || true)"

    assert "claude: 真实 git commit 触发 pre-commit（TDD 阻断）" \
           "$(echo "$commit_out" | grep -q '\[TDD\]' && echo true || echo false)"

    local cfg; cfg="$(git -C "$tmp" config harness.backend-dir 2>/dev/null || echo '')"
    assert "claude: config harness.backend-dir = .claude" \
           "$([ "$cfg" = ".claude" ] && echo true || echo false)"

    rm -rf "$tmp"
}

# ============================================================
# E2E-4: codex 框架文件保护 — stage 框架文件被阻断; .framework-edit 放行
# ============================================================
test_framework_protection_e2e() {
    echo "=== E2E-4: codex 框架文件保护（阻断 + bypass 放行）==="
    local tmp; tmp="$(mktemp -d)"
    make_repo "$tmp"

    run_install_lite codex "$tmp"

    local trampoline_marker="Auto-generated hook trampoline"
    assert "codex 框架保护: trampoline 存在（前置条件）" \
           "$([ -f "$tmp/.git/hooks/pre-commit" ] && grep -q "$trampoline_marker" "$tmp/.git/hooks/pre-commit" && echo true || echo false)"

    # 创建 .framework-manifest（pre-commit L50 检查的触发条件）
    # 列出 .codex/hooks 为框架目录
    printf 'd .codex/hooks\nf .codex/hooks/git/pre-commit\n' > "$tmp/.framework-manifest"
    git -C "$tmp" add .framework-manifest

    # stage 框架文件（.codex/hooks/ 下）— 需 -f 因 .gitignore 可能忽略 .codex/
    echo "# probe" > "$tmp/.codex/hooks/git/_probe.py"
    git -C "$tmp" add -f .codex/hooks/git/_probe.py 2>/dev/null || true

    # 无 bypass → pre-commit 阻断框架文件变更（exit 1）
    local block_out
    block_out="$(git -C "$tmp" commit -m "[0000] DEV test[AI·Developer]

feat: probe framework file" 2>&1 || true)"

    assert "codex 框架保护: stage 框架文件被阻断（exit 1 + 提示）" \
           "$(echo "$block_out" | grep -q '框架文件变更' && echo true || echo false)"

    # 创建 bypass 标记 + 源仓特征文件（pre-commit L74 要求 pre-receive 存在）
    # marker 统一在 .harness/（backend-path-cleanup）
    mkdir -p "$tmp/.harness"
    touch "$tmp/.harness/.framework-edit"
    # pre-receive 已由 do_install_lite 复制到 .codex/hooks/git/（lite 复制全部 hooks/git/）
    assert "codex 框架保护: .codex/hooks/git/pre-receive 存在（bypass 前置条件）" \
           "$([ -f "$tmp/.codex/hooks/git/pre-receive" ] && echo true || echo false)"

    # 有 bypass → pre-commit 放行（框架文件不再阻断）
    # 注意: TDD 检查仍会阻断 _probe.py（生产代码无测试），
    #   但框架文件保护段不再 exit 1（bypass 生效）。TDD 检查中 .codex/ 被
    #   grep -vE 过滤 → _probe.py 不进入 _PROD → TDD 也放行。
    #   故 commit 应成功。
    local bypass_out bypass_rc
    bypass_out="$(git -C "$tmp" commit -m "[0000] DEV test[AI·Developer]

feat: probe with bypass" 2>&1)" && bypass_rc=0 || bypass_rc=$?

    assert "codex 框架保护: .framework-edit 存在时放行（commit 成功）" \
           "$([ "$bypass_rc" = "0" ] && echo true || echo false)"

    rm -rf "$tmp"
}

# ============================================================
# E2E-5: standalone setup-hooks.sh 读 config（无 HARNESS_BACKEND 时）
# ============================================================
test_standalone_config_e2e() {
    echo "=== E2E-5: standalone setup-hooks.sh 读 config 重建 trampoline ==="
    local tmp; tmp="$(mktemp -d)"
    make_repo "$tmp"

    # 先正常 codex 安装（写 config + 装 trampoline）
    run_install_lite codex "$tmp"

    local trampoline_marker="Auto-generated hook trampoline"
    assert "standalone: codex 安装后 trampoline 存在（前置）" \
           "$([ -f "$tmp/.git/hooks/pre-commit" ] && echo true || echo false)"

    # 删除 trampoline（模拟用户误删 / 重置）
    rm -f "$tmp/.git/hooks/pre-commit" "$tmp/.git/hooks/commit-msg" "$tmp/.git/hooks/pre-push"

    assert "standalone: 删除 trampoline 后 .git/hooks/pre-commit 不存在" \
           "$([ ! -f "$tmp/.git/hooks/pre-commit" ] && echo true || echo false)"

    # standalone 运行 setup-hooks.sh（无 HARNESS_BACKEND 环境变量）
    # 应读已写的 git config harness.backend-dir=.codex → HOOKS_SRC=.codex/hooks/git
    # 注意: setup-hooks.sh 路径在 .codex/tools/scripts/setup/（lite 安装复制到此）
    (
        cd "$tmp" || exit 1
        unset HARNESS_BACKEND
        bash "$tmp/.codex/tools/scripts/setup/setup-hooks.sh" install
    ) >/dev/null 2>&1 || true

    # config 仍在（standalone 运行前已写），setup-hooks.sh 应读 config → 重建 trampoline
    assert "standalone: 读 config 重建 .git/hooks/pre-commit trampoline" \
           "$([ -f "$tmp/.git/hooks/pre-commit" ] && grep -q "$trampoline_marker" "$tmp/.git/hooks/pre-commit" && echo true || echo false)"
    assert "standalone: 读 config 重建 .git/hooks/commit-msg trampoline" \
           "$([ -f "$tmp/.git/hooks/commit-msg" ] && grep -q "$trampoline_marker" "$tmp/.git/hooks/commit-msg" && echo true || echo false)"
    assert "standalone: 读 config 重建 .git/hooks/pre-push trampoline" \
           "$([ -f "$tmp/.git/hooks/pre-push" ] && grep -q "$trampoline_marker" "$tmp/.git/hooks/pre-push" && echo true || echo false)"

    rm -rf "$tmp"
}

# ============================================================
# E2E-6: setup-hooks.sh 源码检查 — HOOKS_SRC 不再写死 .claude
# ============================================================
test_source_code_hooksrc() {
    echo "=== E2E-6: setup-hooks.sh 源码 HOOKS_SRC 不写死 .claude ==="

    # C8 根因: L14 写死 HOOKS_SRC="$PROJECT_ROOT/.claude/hooks/git"
    # fix 后应读 HARNESS_BACKEND 或 config 推导
    assert "setup-hooks.sh 不含写死 HOOKS_SRC=.claude/hooks/git" \
           "$(! grep -q 'HOOKS_SRC="$PROJECT_ROOT/.claude/hooks/git"' "$SETUP_HOOKS_SH" && echo true || echo false)"
    assert "setup-hooks.sh 含 HARNESS_BACKEND 推导" \
           "$(grep -q 'HARNESS_BACKEND' "$SETUP_HOOKS_SH" && echo true || echo false)"
    assert "setup-hooks.sh 含 config fallback 推导" \
           "$(grep -q 'config --get harness.backend-dir' "$SETUP_HOOKS_SH" && echo true || echo false)"
}

# ============================================================
# 主入口
# ============================================================
echo ""
echo "╔═══════════════════════════════════════════════════════╗"
echo "║  test_hook_backend_e2e.sh — C8 fix hook-trigger E2E  ║"
echo "╚═══════════════════════════════════════════════════════╝"
echo ""

# 源仓不应预设 harness.backend-dir（否则干扰测试）
if git -C "$PROJECT_ROOT" config --get harness.backend-dir >/dev/null 2>&1; then
    echo "WARN: 源仓已设 harness.backend-dir，可能干扰测试" >&2
fi

test_codex_e2e
test_codebuddy_e2e
test_claude_e2e
test_framework_protection_e2e
test_standalone_config_e2e
test_source_code_hooksrc

echo ""
echo "════════════════════════════════════════════════════════"
echo "  Results: $PASS passed, $FAIL failed"
echo "════════════════════════════════════════════════════════"

[ "$FAIL" = "0" ] || exit 1
