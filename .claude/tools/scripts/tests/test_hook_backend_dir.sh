#!/usr/bin/env bash
# test_hook_backend_dir.sh — 验证 hook backend-dir config 机制 (C1+C2)
#
# 测试矩阵 (design §7.1):
#   T1 codex lite 安装: config=.codex, hooks 装在 .codex/hooks/git/
#   T2 codebuddy lite 安装: config=.codebuddy
#   T3 claude lite 安装: config=.claude (回归, 行为等价改动前)
#   T4 fallback (无 config): 探测头 fallback .claude
#   T5 重跑 setup 更新 config: claude→codex
#   T6 源仓 (config 未设) 不误判: fallback .claude, 不命中共存 .codex/
#   T7 L115 正则 (C2): .codex/ 被过滤, Xcodex/ 不被过滤 (点号转义)
#   T8 C1 多值 config 防御: head -1 取首个值
#
# 参考: test_codex_fanout_parallel.sh / test_backend_detection.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR"/../../../.. && pwd)"
SETUP_SH="$PROJECT_ROOT/.claude/tools/scripts/setup/setup-harness.sh"
PRE_COMMIT="$PROJECT_ROOT/.claude/hooks/git/pre-commit"
PRE_PUSH="$PROJECT_ROOT/.claude/hooks/git/pre-push"

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

# ── 辅助：提取 setup-harness.sh 函数定义（不含入口点） ──
# awk 在入口标记行停止输出，仅保留函数定义 + 常量
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
        # 先 source 提取的函数（含 set -euo pipefail + 常量 + 函数定义）
        # shellcheck disable=SC1090
        source "$funcs"
        # 覆盖 HARNESS_SOURCE 为源仓根（source 时 BASH_SOURCE 指向 temp 文件致路径错误）
        HARNESS_SOURCE="$PROJECT_ROOT"
        export HARNESS_BACKEND="$backend"
        do_install_lite "$target"
    ) >/dev/null 2>&1 || true
    rm -f "$funcs"
}

# ============================================================
# T1: codex lite 安装
# ============================================================
test_codex_lite() {
    echo "=== T1: codex lite 安装 ==="
    local tmp; tmp="$(mktemp -d)"
    make_repo "$tmp"

    run_install_lite codex "$tmp"

    local cfg; cfg="$(git -C "$tmp" config harness.backend-dir 2>/dev/null || echo '')"
    assert "config harness.backend-dir = .codex" \
           "$([ "$cfg" = ".codex" ] && echo true || echo false)"
    assert "hooks 装在 .codex/hooks/git/pre-commit" \
           "$([ -f "$tmp/.codex/hooks/git/pre-commit" ] && echo true || echo false)"
    assert "hooks 装在 .codex/hooks/git/pre-push" \
           "$([ -f "$tmp/.codex/hooks/git/pre-push" ] && echo true || echo false)"
    assert ".claude/hooks/git/ 不存在（lite 装到 .codex 非 .claude）" \
           "$([ ! -f "$tmp/.claude/hooks/git/pre-commit" ] && echo true || echo false)"

    rm -rf "$tmp"
}

# ============================================================
# T2: codebuddy lite 安装
# ============================================================
test_codebuddy_lite() {
    echo "=== T2: codebuddy lite 安装 ==="
    local tmp; tmp="$(mktemp -d)"
    make_repo "$tmp"

    run_install_lite codebuddy "$tmp"

    local cfg; cfg="$(git -C "$tmp" config harness.backend-dir 2>/dev/null || echo '')"
    assert "config harness.backend-dir = .codebuddy" \
           "$([ "$cfg" = ".codebuddy" ] && echo true || echo false)"
    assert "hooks 装在 .codebuddy/hooks/git/pre-commit" \
           "$([ -f "$tmp/.codebuddy/hooks/git/pre-commit" ] && echo true || echo false)"

    rm -rf "$tmp"
}

# ============================================================
# T3: claude lite 安装（回归, 行为等价改动前）
# ============================================================
test_claude_lite() {
    echo "=== T3: claude lite 安装（回归） ==="
    local tmp; tmp="$(mktemp -d)"
    make_repo "$tmp"

    run_install_lite claude "$tmp"

    local cfg; cfg="$(git -C "$tmp" config harness.backend-dir 2>/dev/null || echo '')"
    assert "config harness.backend-dir = .claude" \
           "$([ "$cfg" = ".claude" ] && echo true || echo false)"
    assert "hooks 装在 .claude/hooks/git/pre-commit" \
           "$([ -f "$tmp/.claude/hooks/git/pre-commit" ] && echo true || echo false)"

    rm -rf "$tmp"
}

# ============================================================
# T4: fallback (无 config) — 探测头 fallback .claude
# ============================================================
test_fallback_no_config() {
    echo "=== T4: fallback (无 config → .claude) ==="
    local tmp; tmp="$(mktemp -d)"
    make_repo "$tmp"

    # 模拟探测头 (C1 写法) — 无 config
    local REPO_ROOT="$tmp"
    local _HARNESS_DIR
    _HARNESS_DIR="$(git -C "$REPO_ROOT" config --get harness.backend-dir 2>/dev/null | head -1 || true)"
    _HARNESS_DIR="${_HARNESS_DIR:-.claude}"

    assert "无 config → _HARNESS_DIR = .claude" \
           "$([ "$_HARNESS_DIR" = ".claude" ] && echo true || echo false)"

    # 验证 pre-commit hook 源码包含探测头
    assert "pre-commit 包含 config --get 探测头" \
           "$(grep -q 'config --get harness.backend-dir' "$PRE_COMMIT" && echo true || echo false)"

    rm -rf "$tmp"
}

# ============================================================
# T5: 重跑 setup 更新 config (claude→codex)
# ============================================================
test_rerup_updates_config() {
    echo "=== T5: 重跑 setup 更新 config (claude→codex) ==="
    local tmp; tmp="$(mktemp -d)"
    make_repo "$tmp"

    # 第一次 claude
    run_install_lite claude "$tmp"
    local cfg1; cfg1="$(git -C "$tmp" config harness.backend-dir 2>/dev/null || echo '')"
    assert "首次 claude 安装: config = .claude" \
           "$([ "$cfg1" = ".claude" ] && echo true || echo false)"

    # 第二次 codex
    run_install_lite codex "$tmp"
    local cfg2; cfg2="$(git -C "$tmp" config harness.backend-dir 2>/dev/null || echo '')"
    assert "重跑 codex 安装: config 更新为 .codex" \
           "$([ "$cfg2" = ".codex" ] && echo true || echo false)"
    assert ".codex/hooks/git/pre-commit 存在" \
           "$([ -f "$tmp/.codex/hooks/git/pre-commit" ] && echo true || echo false)"

    rm -rf "$tmp"
}

# ============================================================
# T6: 源仓场景 (config 未设 + .codex/ 共存) 不误判
# ============================================================
test_source_repo_no_misjudge() {
    echo "=== T6: 源仓场景 (config 未设 + .codex/ 共存) ==="
    local tmp; tmp="$(mktemp -d)"
    make_repo "$tmp"

    # 模拟源仓: .claude/ 和 .codex/ 共存, 但不设 config
    mkdir -p "$tmp/.claude/hooks/git" "$tmp/.codex/hooks/git"

    local REPO_ROOT="$tmp"
    local _HARNESS_DIR
    _HARNESS_DIR="$(git -C "$REPO_ROOT" config --get harness.backend-dir 2>/dev/null | head -1 || true)"
    _HARNESS_DIR="${_HARNESS_DIR:-.claude}"

    assert "config 未设 → fallback .claude (不命中共存 .codex/)" \
           "$([ "$_HARNESS_DIR" = ".claude" ] && echo true || echo false)"

    # 验证 pre-push 探测头不再有 for 循环目录探测块
    assert "pre-push 不含 for 循环目录探测 (.codex > .codebuddy)" \
           "$(! grep -q 'for _hd in' "$PRE_PUSH" && echo true || echo false)"

    rm -rf "$tmp"
}

# ============================================================
# T7: L115 正则 (C2) — .codex/ 过滤, Xcodex/ 不过滤
# ============================================================
test_l115_regex_escape() {
    echo "=== T7: L115 正则点号转义 (C2) ==="

    # 模拟 _HARNESS_DIR=.codex 的正则
    local _HARNESS_DIR=".codex"
    local _HARNESS_DIR_ESC="${_HARNESS_DIR//./\\.}"  # .codex → \.codex

    # 输入: .codex/ 开头 + Xcodex/ 开头 + .harness/ 开头 + 普通 py 文件
    local input
    input="$(printf '.codex/hooks/git/pre-commit\nXcodex/foo.py\n.codebuddy/bar.py\n.harness/baz.py\nsrc/main.py\n')"

    # 过滤链 (仅 L115 正则部分)
    local result
    result="$(echo "$input" | grep -vE "(^${_HARNESS_DIR_ESC}/|^\.harness/)")"

    # .codex/hooks/... 应被过滤（框架文件）
    assert ".codex/ 被正则过滤" \
           "$(echo "$result" | grep -q '^\.codex/' && echo false || echo true)"

    # Xcodex/ 不应被过滤（点号转义后只匹配字面 .codex 不匹配 Xcodex）
    # 注意: 如果未转义点号 (^.codex/), . 元字符会匹配 X, Xcodex/ 会被误过滤
    assert "Xcodex/ 不被误过滤 (点号转义生效)" \
           "$(echo "$result" | grep -q '^Xcodex/foo.py' && echo true || echo false)"

    # .harness/ 被过滤
    assert ".harness/ 被过滤" \
           "$(echo "$result" | grep -q '^\.harness/' && echo false || echo true)"

    # .codebuddy/ 不被过滤（不是当前 backend）
    assert ".codebuddy/ 不被过滤（非当前 backend）" \
           "$(echo "$result" | grep -q '^\.codebuddy/bar.py' && echo true || echo false)"

    # src/ 不被过滤（生产代码）
    assert "src/main.py 不被过滤（生产代码）" \
           "$(echo "$result" | grep -q '^src/main.py' && echo true || echo false)"

    # 验证 pre-commit 源码用双引号 + 变量展开（非单引号字面量）
    assert "pre-commit L115 正则用双引号变量展开" \
           "$(grep -q 'grep -vE "(^' "$PRE_COMMIT" && echo true || echo false)"

    # 验证 pre-commit 源码有点号转义逻辑
    assert "pre-commit 包含 _HARNESS_DIR_ESC 转义" \
           "$(grep -q '_HARNESS_DIR_ESC' "$PRE_COMMIT" && echo true || echo false)"
}

# ============================================================
# T8: C1 多值 config 防御 — head -1 取首个值
# ============================================================
test_multivalue_config() {
    echo "=== T8: C1 多值 config 防御 ==="
    local tmp; tmp="$(mktemp -d)"
    make_repo "$tmp"

    # 设置多个值
    git -C "$tmp" config harness.backend-dir ".codex"
    git -C "$tmp" config --add harness.backend-dir ".codebuddy"

    local REPO_ROOT="$tmp"
    local _HARNESS_DIR
    # C1 探测头: --get 多值时不同 git 版本行为不同（有的返回多行 exit 1，有的返回单行 exit 0）。
    # 防御目标: 不崩溃、不含换行、返回合法 backend 值。head -1 保证只取一行。
    _HARNESS_DIR="$(git -C "$REPO_ROOT" config --get harness.backend-dir 2>/dev/null | head -1 || true)"
    _HARNESS_DIR="${_HARNESS_DIR:-.claude}"

    # 验证结果不含换行（防御多行导致 [ -f ] 静默失效）
    local has_newline="false"
    [[ "$_HARNESS_DIR" == *$'\n'* ]] && has_newline="true"
    assert "多值 config → 结果不含换行 (C1 防御核心)" "$([ "$has_newline" = "false" ] && echo true || echo false)"

    # 验证结果是合法 backend 值之一（不崩溃）
    assert "多值 config → 结果是合法 backend (.codex/.codebuddy)" \
           "$(case "$_HARNESS_DIR" in .codex|.codebuddy) echo true;; *) echo false;; esac)"

    # 验证 pre-commit 用 --get + head -1 (C1)；pre-push 不再需要（marker 改 .harness/ 后死代码已删）
    assert "pre-commit 探测头含 --get + head -1" \
           "$(grep -q -- '--get harness.backend-dir.*| head -1' "$PRE_COMMIT" && echo true || echo false)"
    assert "pre-push 不含 --get harness.backend-dir 探测（DBC-003 死代码已删）" \
           "$(! grep -q -- '--get harness.backend-dir' "$PRE_PUSH" && echo true || echo false)"

    rm -rf "$tmp"
}

# ============================================================
# T-extra: pre-push 路径引用验证（CHALLENGE_FILE / TOKEN_FILE 用 .harness/）
# ============================================================
test_pre_push_path_refs() {
    echo "=== T-extra: pre-push 路径引用 ==="
    assert "pre-push CHALLENGE_FILE 用 .harness/.push-challenge" \
           "$(grep -q 'CHALLENGE_FILE=".harness/.push-challenge"' "$PRE_PUSH" && echo true || echo false)"
    assert "pre-push TOKEN_FILE 用 .harness/.push-approved" \
           "$(grep -q 'TOKEN_FILE=".harness/.push-approved"' "$PRE_PUSH" && echo true || echo false)"
    assert "pre-push 提示文字用 .harness/.push-approved (无字面 .claude/.push-approved)" \
           "$(! grep -q '\.claude/\.push-approved' "$PRE_PUSH" && echo true || echo false)"
    assert "pre-push 不含 _HARNESS_DIR 死代码（DBC-003）" \
           "$(! grep -q '_HARNESS_DIR=.*config.*harness.backend-dir' "$PRE_PUSH" && echo true || echo false)"
}

# ============================================================
# T-extra: pre-commit 路径引用验证（.framework-edit 用 .harness/）
# ============================================================
test_pre_commit_path_refs() {
    echo "=== T-extra: pre-commit 路径引用 ==="
    assert "pre-commit _FRAMEWORK_EDIT_BYPASS 用 .harness/.framework-edit" \
           "$(grep -q 'REPO_ROOT/\.harness/\.framework-edit' "$PRE_COMMIT" && echo true || echo false)"
    assert "pre-commit BYPASS_FILE 用 .harness/.framework-edit" \
           "$(grep -q 'BYPASS_FILE="\$REPO_ROOT/\.harness/\.framework-edit"' "$PRE_COMMIT" && echo true || echo false)"
    assert "pre-commit 提示文字 setup-harness.sh 不含字面 .claude/tools" \
           "$(! grep -q 'bash \.claude/tools/scripts/setup/setup-harness.sh' "$PRE_COMMIT" && echo true || echo false)"
}

# ============================================================
# T-extra: commit-msg / pre-receive 不改（超范围保护）
# ============================================================
test_scope_guard() {
    echo "=== T-extra: 范围保护 (commit-msg / pre-receive 不改) ==="
    local commit_msg="$PROJECT_ROOT/.claude/hooks/git/commit-msg"
    local pre_receive="$PROJECT_ROOT/.claude/hooks/git/pre-receive"

    # commit-msg 不引入 _HARNESS_DIR（选项 A: 完全不改）
    assert "commit-msg 不含 _HARNESS_DIR (不改)" \
           "$(! grep -q '_HARNESS_DIR' "$commit_msg" && echo true || echo false)"

    # pre-receive 不引入 _HARNESS_DIR（排除: 服务端 hook）
    assert "pre-receive 不含 _HARNESS_DIR (不改)" \
           "$(! grep -q '_HARNESS_DIR' "$pre_receive" && echo true || echo false)"
}

# ============================================================
# 主入口
# ============================================================
echo ""
echo "╔═══════════════════════════════════════════════════════╗"
echo "║  test_hook_backend_dir.sh — hook backend-dir 机制    ║"
echo "╚═══════════════════════════════════════════════════════╝"
echo ""

# 源仓不应预设 harness.backend-dir（否则干扰测试）
if git -C "$PROJECT_ROOT" config --get harness.backend-dir >/dev/null 2>&1; then
    echo "WARN: 源仓已设 harness.backend-dir，可能干扰测试" >&2
fi

test_codex_lite
test_codebuddy_lite
test_claude_lite
test_fallback_no_config
test_rerup_updates_config
test_source_repo_no_misjudge
test_l115_regex_escape
test_multivalue_config
test_pre_push_path_refs
test_pre_commit_path_refs
test_scope_guard

echo ""
echo "════════════════════════════════════════════════════════"
echo "  Results: $PASS passed, $FAIL failed"
echo "════════════════════════════════════════════════════════"

[ "$FAIL" = "0" ] || exit 1
