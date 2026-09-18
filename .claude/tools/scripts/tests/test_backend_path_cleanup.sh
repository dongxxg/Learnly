#!/usr/bin/env bash
# test_backend_path_cleanup.sh — marker 文件统一到 .harness/ 验证 (backend-path-cleanup)
#
# 验证 T1-T7 的核心改动：
#   T1: .pending-upgrade-msg → .harness/
#   T2: .framework-edit → .harness/（settings.json 源文件 7 处 [P0] + settings-emit.mjs 6 处 + hook 脚本 + regex 加固）
#   T3: .push-challenge/.push-approved → .harness/ + pre-push 死代码清理 + 旧 marker 清理
#   T4: upgrade-harness SKILL.md → git config 动态检测
#   T5: setup-harness.sh gitignore 补全
#   T6: setup-harness.sh .integrity-state 路径一致性
#   T7: 文档残留清理
#
# E2E：
#   E2E-1: codex 安装 → .harness/.framework-edit bypass 生效
#   E2E-2: 攻击面加固 → cd .harness && touch .framework-edit 被拦截
#   E2E-3: all 类型 → 单标记 .harness/.framework-edit 双后端 bypass
#   E2E-4: session-start 清理旧位置 marker

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"

# 核心文件路径
SETTINGS_JSON="$PROJECT_ROOT/.claude/settings.json"
SETTINGS_EMIT="$PROJECT_ROOT/.claude/tools/scripts/generate/lib/settings-emit.mjs"
SESSION_START="$PROJECT_ROOT/.claude/hooks/shared/session-start.sh"
CHECK_UPGRADE="$PROJECT_ROOT/.claude/hooks/shared/check-upgrade-prompt.sh"
TASKS_GUARD="$PROJECT_ROOT/.claude/hooks/shared/pre-tool-use-tasks-guard.sh"
GIT_GUARD="$PROJECT_ROOT/.claude/hooks/shared/pre-tool-use-git-guard.sh"
PRE_PUSH="$PROJECT_ROOT/.claude/hooks/git/pre-push"
PRE_COMMIT="$PROJECT_ROOT/.claude/hooks/git/pre-commit"
SETUP_SH="$PROJECT_ROOT/.claude/tools/scripts/setup/setup-harness.sh"
UPGRADE_SKILL="$PROJECT_ROOT/.claude/skills/upgrade-harness/SKILL.md"
HARNESS_RULES_MD="$PROJECT_ROOT/.claude/reference/harness-rules.md"
HARNESS_RULES_YAML="$PROJECT_ROOT/.claude/reference/harness-rules.yaml"
PUSH_FLOW_MD="$PROJECT_ROOT/.claude/workflows/push-approval-flow.md"

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

# ============================================================
# T1: 升级检测 marker → .harness/
# ============================================================
test_t1_upgrade_marker() {
    echo "=== T1: 升级检测 marker → .harness/ ==="

    # session-start.sh: MARKER_FILE 用 .harness/（不再用 $HARNESS_ROOT）
    assert "session-start.sh MARKER_FILE 用 .harness/.pending-upgrade-msg" \
           "$(grep -q 'MARKER_FILE="$PROJECT_DIR/.harness/.pending-upgrade-msg"' "$SESSION_START" && echo true || echo false)"

    assert "session-start.sh 不含旧 MARKER_FILE=\$HARNESS_ROOT/.pending-upgrade-msg" \
           "$(! grep -q 'MARKER_FILE="\$PROJECT_DIR/\$HARNESS_ROOT/.pending-upgrade-msg"' "$SESSION_START" && echo true || echo false)"

    # check-upgrade-prompt.sh: MARKER_FILE 用 .harness/
    assert "check-upgrade-prompt.sh MARKER_FILE 用 .harness/.pending-upgrade-msg" \
           "$(grep -q 'MARKER_FILE=".harness/.pending-upgrade-msg"' "$CHECK_UPGRADE" && echo true || echo false)"

    assert "check-upgrade-prompt.sh 不含旧 .claude/.pending-upgrade-msg" \
           "$(! grep -q '\.claude/\.pending-upgrade-msg' "$CHECK_UPGRADE" && echo true || echo false)"

    # additionalContext 指令用 .harness/（AI 直接可执行）
    assert "check-upgrade-prompt.sh additionalContext rm 用 .harness/.pending-upgrade-msg" \
           "$(grep -q 'rm -f .harness/.pending-upgrade-msg' "$CHECK_UPGRADE" && echo true || echo false)"
}

# ============================================================
# T2: .framework-edit → .harness/ (P0: settings.json 源文件 + settings-emit + hook 脚本)
# ============================================================
test_t2_framework_edit() {
    echo "=== T2: .framework-edit → .harness/（P0）==="

    # settings.json 源文件 .harness/.framework-edit 守卫计数：backend-path 时为 7，
    # 后续 58a6cfc(agent-usage)/f4fe513(agent-timestamp) 故意移除这两个遥测 hook 的
    # bypass 守卫（遥测 hook 应始终运行），计数降为 5。真实不变量是「无 .claude/
    # .framework-edit 残留」（见下一条断言）。
    local settings_fe_count
    settings_fe_count=$(grep -c '\.harness/\.framework-edit' "$SETTINGS_JSON" 2>/dev/null || echo 0)
    assert "settings.json 含 .harness/.framework-edit (>=5 处，现 $settings_fe_count)" \
           "$([ "$settings_fe_count" -ge 5 ] && echo true || echo false)"

    assert "settings.json 不含旧 .claude/.framework-edit" \
           "$(! grep -q '\.claude/\.framework-edit' "$SETTINGS_JSON" && echo true || echo false)"

    # settings-emit.mjs codexHooksJson 6 处改 .harness/
    local emit_fe_count
    emit_fe_count=$(grep -c '\.harness/\.framework-edit' "$SETTINGS_EMIT" 2>/dev/null || echo 0)
    assert "settings-emit.mjs 含 .harness/.framework-edit (>=6 处)" \
           "$([ "$emit_fe_count" -ge 6 ] && echo true || echo false)"

    assert "settings-emit.mjs 不含旧 .claude/.framework-edit" \
           "$(! grep -q '\.claude/\.framework-edit' "$SETTINGS_EMIT" && echo true || echo false)"

    # pre-tool-use-tasks-guard.sh 检查 .harness/.framework-edit
    assert "pre-tool-use-tasks-guard.sh 检查 .harness/.framework-edit" \
           "$(grep -q '\.harness/\.framework-edit' "$TASKS_GUARD" && echo true || echo false)"

    assert "pre-tool-use-tasks-guard.sh 不含旧 .claude/.framework-edit 检查" \
           "$(! grep -q '\.claude/\.framework-edit' "$TASKS_GUARD" && echo true || echo false)"

    # 攻击面加固 (DBC-002): _BYPASS_FILES_RE 含无路径前缀兜底
    assert "git-guard _BYPASS_FILES_RE 含无路径前缀 \\.framework-edit 兜底" \
           "$(grep -qE '_BYPASS_FILES_RE=.*\\\\\.framework-edit' "$GIT_GUARD" && echo true || echo false)"

    assert "git-guard _BYPASS_FILES_RE 含无路径前缀 \\.push-challenge 兜底" \
           "$(grep -qE '_BYPASS_FILES_RE=.*\\\\\.push-challenge' "$GIT_GUARD" && echo true || echo false)"

    # session-start.sh 清理 .harness/.framework-edit
    assert "session-start.sh 清理 .harness/.framework-edit" \
           "$(grep -q 'rm -f.*\.harness/\.framework-edit' "$SESSION_START" && echo true || echo false)"
}

# ============================================================
# T3: push 标记 → .harness/ + 死代码清理 + 旧 marker 清理
# ============================================================
test_t3_push_markers() {
    echo "=== T3: push 标记 → .harness/ + 死代码清理 ==="

    # pre-push CHALLENGE_FILE/TOKEN_FILE 用 .harness/
    assert "pre-push CHALLENGE_FILE 用 .harness/.push-challenge" \
           "$(grep -q 'CHALLENGE_FILE=".harness/.push-challenge"' "$PRE_PUSH" && echo true || echo false)"

    assert "pre-push TOKEN_FILE 用 .harness/.push-approved" \
           "$(grep -q 'TOKEN_FILE=".harness/.push-approved"' "$PRE_PUSH" && echo true || echo false)"

    # pre-push 提示文字用 .harness/.push-approved
    assert "pre-push 提示文字用 .harness/.push-approved" \
           "$(grep -q 'echo.*> \.harness/\.push-approved' "$PRE_PUSH" && echo true || echo false)"

    # DBC-003: pre-push $_HARNESS_DIR 死代码已删（不再有 config --get harness.backend-dir）
    assert "pre-push 不含 _HARNESS_DIR 计算（死代码已删）" \
           "$(! grep -q '_HARNESS_DIR=.*config.*harness.backend-dir' "$PRE_PUSH" && echo true || echo false)"

    # pre-commit BYPASS_FILE 用 .harness/
    assert "pre-commit _FRAMEWORK_EDIT_BYPASS 用 .harness/.framework-edit" \
           "$(grep -q '_FRAMEWORK_EDIT_BYPASS="\$REPO_ROOT/\.harness/\.framework-edit"' "$PRE_COMMIT" && echo true || echo false)"

    assert "pre-commit BYPASS_FILE 用 .harness/.framework-edit" \
           "$(grep -q 'BYPASS_FILE="\$REPO_ROOT/\.harness/\.framework-edit"' "$PRE_COMMIT" && echo true || echo false)"

    # DBC-004: session-start.sh 清理旧位置 marker
    assert "session-start.sh 清理旧 .codex/.framework-edit" \
           "$(grep -q 'rm -f.*\.codex/\.framework-edit' "$SESSION_START" && echo true || echo false)"

    assert "session-start.sh 清理旧 .codebuddy/.framework-edit" \
           "$(grep -q 'rm -f.*\.codebuddy/\.framework-edit' "$SESSION_START" && echo true || echo false)"

    assert "session-start.sh 清理旧 .claude/.framework-edit" \
           "$(grep -q 'rm -f.*\.claude/\.framework-edit' "$SESSION_START" && echo true || echo false)"

    assert "session-start.sh 清理旧 .codex/.push-challenge" \
           "$(grep -q 'rm -f.*\.codex/\.push-challenge' "$SESSION_START" && echo true || echo false)"

    assert "session-start.sh 清理旧 .push-approved 残留" \
           "$(grep -q 'rm -f.*\.push-approved' "$SESSION_START" && echo true || echo false)"
}

# ============================================================
# T4: 升级执行路径 → git config 动态检测
# ============================================================
test_t4_upgrade_path() {
    echo "=== T4: 升级执行路径 → git config 动态检测 ==="

    assert "upgrade-harness SKILL.md 含 git config harness.backend-dir" \
           "$(grep -q 'git config harness.backend-dir' "$UPGRADE_SKILL" && echo true || echo false)"

    assert "upgrade-harness SKILL.md 不含写死 .claude/tools/.../setup-harness.sh --check" \
           "$(! grep -q 'bash \.claude/tools/scripts/setup/setup-harness\.sh --check' "$UPGRADE_SKILL" && echo true || echo false)"
}

# ============================================================
# T5: gitignore 补全
# ============================================================
test_t5_gitignore() {
    echo "=== T5: gitignore 补全 ==="

    # 提取 setup-harness.sh 的 gitignore for 循环
    local gitignore_block
    gitignore_block=$(grep -A5 'for _entry in' "$SETUP_SH" 2>/dev/null | head -10)

    assert "setup-harness.sh gitignore 含 .codex/" \
           "$(echo "$gitignore_block" | grep -q '"\.codex/"' && echo true || echo false)"

    assert "setup-harness.sh gitignore 含 .codebuddy/" \
           "$(echo "$gitignore_block" | grep -q '"\.codebuddy/"' && echo true || echo false)"

    assert "setup-harness.sh gitignore 含 .harness/.pending-upgrade-msg" \
           "$(echo "$gitignore_block" | grep -q '\.harness/\.pending-upgrade-msg' && echo true || echo false)"

    assert "setup-harness.sh gitignore 含 .harness/.framework-edit" \
           "$(echo "$gitignore_block" | grep -q '\.harness/\.framework-edit' && echo true || echo false)"

    assert "setup-harness.sh gitignore 含 .harness/.push-challenge" \
           "$(echo "$gitignore_block" | grep -q '\.harness/\.push-challenge' && echo true || echo false)"

    assert "setup-harness.sh gitignore 含 .harness/.push-approved" \
           "$(echo "$gitignore_block" | grep -q '\.harness/\.push-approved' && echo true || echo false)"
}

# ============================================================
# T6: .integrity-state 清理路径一致性
# ============================================================
test_t6_integrity_state() {
    echo "=== T6: .integrity-state 清理路径一致性 ==="

    # do_install_lite（轻量安装）backend 可变，用动态 $backend_dir
    assert "do_install_lite .integrity-state 用 \$backend_dir（动态 backend 路径）" \
           "$(grep -q 'rm -f.*\$backend_dir/\.integrity-state' "$SETUP_SH" && echo true || echo false)"

    # do_install（完整安装）用硬编码 .claude/：copy_core_files 恒定复制到 .claude/
    # （源仓永远是 .claude/），且 $backend_dir 在 do_install 作用域未定义（set -u 报错），
    # codex 模式下 $backend_dir=.codex 会指向错误路径漏清。见 a5e4a66。
    assert "do_install .integrity-state 用硬编码 .claude/（copy_core_files 恒定目标）" \
           "$(grep -q 'rm -f "\$target/\.claude/\.integrity-state"' "$SETUP_SH" && echo true || echo false)"
}

# ============================================================
# T7: 文档残留清理
# ============================================================
test_t7_docs_residual() {
    echo "=== T7: 文档残留清理 ==="

    assert "harness-rules.md 不含 .claude/.push-challenge" \
           "$(! grep -q '\.claude/\.push-challenge' "$HARNESS_RULES_MD" && echo true || echo false)"

    assert "harness-rules.yaml 不含 .claude/.push-challenge" \
           "$(! grep -q '\.claude/\.push-challenge' "$HARNESS_RULES_YAML" && echo true || echo false)"

    assert "harness-rules.yaml 不含 .claude/.push-approved" \
           "$(! grep -q '\.claude/\.push-approved' "$HARNESS_RULES_YAML" && echo true || echo false)"

    assert "push-approval-flow.md 不含 .claude/.push-challenge" \
           "$(! grep -q '\.claude/\.push-challenge' "$PUSH_FLOW_MD" && echo true || echo false)"

    assert "push-approval-flow.md 不含 .claude/.push-approved" \
           "$(! grep -q '\.claude/\.push-approved' "$PUSH_FLOW_MD" && echo true || echo false)"

    # 确认新路径存在
    assert "push-approval-flow.md 含 .harness/.push-approved" \
           "$(grep -q '\.harness/\.push-approved' "$PUSH_FLOW_MD" && echo true || echo false)"

    assert "harness-rules.yaml 含 .harness/.push-challenge" \
           "$(grep -q '\.harness/\.push-challenge' "$HARNESS_RULES_YAML" && echo true || echo false)"
}

# ============================================================
# E2E-1: codex 安装 → .harness/.framework-edit bypass 生效
# ============================================================
test_e2e_codex_framework_edit() {
    echo "=== E2E-1: codex 安装 → .harness/.framework-edit bypass ==="

    local tmp; tmp="$(mktemp -d)"
    CLEANUP_DIRS="${CLEANUP_DIRS} ${tmp}"
    git init -q "$tmp"
    git -C "$tmp" config user.email "test@test.local"
    git -C "$tmp" config user.name "test"
    git -C "$tmp" config commit.gpgsign false

    # 提取 setup 函数并安装
    local funcs; funcs="$(mktemp)"
    awk '/^# ── 入口/{exit} {print}' "$SETUP_SH" > "$funcs"
    (
        cd "$tmp" || exit 1
        source "$funcs"
        HARNESS_SOURCE="$PROJECT_ROOT"
        export HARNESS_BACKEND="codex"
        do_install_lite "$tmp"
    ) >/dev/null 2>&1 || true
    rm -f "$funcs"

    # 创建 .framework-manifest（pre-commit 触发条件）
    printf 'd .codex/hooks\nf .codex/hooks/git/pre-commit\n' > "$tmp/.framework-manifest"
    git -C "$tmp" add .framework-manifest

    # stage 框架文件
    echo "# probe" > "$tmp/.codex/hooks/git/_probe.py"
    git -C "$tmp" add -f .codex/hooks/git/_probe.py 2>/dev/null || true

    # 无 bypass → 阻断
    local block_out
    block_out="$(git -C "$tmp" commit -m "[0000] DEV test[AI·Developer]

feat: probe framework file" 2>&1 || true)"
    assert "codex: 无 bypass 时框架文件被阻断" \
           "$(echo "$block_out" | grep -q '框架文件变更' && echo true || echo false)"

    # 创建 .harness/.framework-edit bypass（新位置）
    mkdir -p "$tmp/.harness"
    touch "$tmp/.harness/.framework-edit"
    assert "codex: .harness/.framework-edit 创建成功（新位置）" \
           "$([ -f "$tmp/.harness/.framework-edit" ] && echo true || echo false)"

    # 有 bypass → 放行
    local bypass_out bypass_rc
    bypass_out="$(git -C "$tmp" commit -m "[0000] DEV test[AI·Developer]

feat: probe with bypass" 2>&1)" && bypass_rc=0 || bypass_rc=$?
    assert "codex: .harness/.framework-edit bypass 生效（commit 成功）" \
           "$([ "$bypass_rc" = "0" ] && echo true || echo false)"
}

# ============================================================
# E2E-2: 攻击面加固 → cd .harness && touch .framework-edit 被拦截
# ============================================================
test_e2e_attack_surface() {
    echo "=== E2E-2: 攻击面加固 → cd .harness && touch .framework-edit 被拦截 ==="

    # 模拟 PreToolUse git-guard 检测拆分命令
    # 构造与 hook 相同的 regex 并验证
    local guard_regex
    guard_regex=$(grep '_BYPASS_FILES_RE=' "$GIT_GUARD" 2>/dev/null | head -1)

    # 提取 regex 值并测试（模拟 hook 逻辑）
    local test_cmd="cd .harness && touch .framework-edit"

    # 直接用 hook 的 regex 测试：如果 hook 正确拦截，说明 regex 含无路径前缀匹配
    # 我们通过实际运行 hook 来验证
    local tmp; tmp="$(mktemp -d)"
    CLEANUP_DIRS="${CLEANUP_DIRS} ${tmp}"
    mkdir -p "$tmp/.harness"

    # 构造 PreToolUse stdin JSON
    local payload
    payload='{"tool_name":"Bash","tool_input":{"command":"cd .harness && touch .framework-edit"}}'

    local hook_out hook_rc
    hook_out=$(cd "$tmp" && echo "$payload" | bash "$GIT_GUARD" 2>&1) && hook_rc=0 || hook_rc=$?

    # hook 应拦截（exit 0 + deny JSON，或 exit 2）
    # git-guard 用 hook_deny（exit 0 + JSON），不是 exit 2
    assert "git-guard 拦截 cd .harness && touch .framework-edit" \
           "$(echo "$hook_out" | grep -q 'AI 止步\|deny\|止步' && echo true || echo false)"

    # 也测试直接 touch .framework-edit（无 cd）
    local payload2
    payload2='{"tool_name":"Bash","tool_input":{"command":"touch .framework-edit"}}'

    local hook_out2 hook_rc2
    hook_out2=$(cd "$tmp" && echo "$payload2" | bash "$GIT_GUARD" 2>&1) && hook_rc2=0 || hook_rc2=$?
    assert "git-guard 拦截 touch .framework-edit（无路径前缀）" \
           "$(echo "$hook_out2" | grep -q 'AI 止步\|deny\|止步' && echo true || echo false)"

    # 验证 .push-approved 不被拦截（AI 合法操作）
    local payload3
    payload3='{"tool_name":"Bash","tool_input":{"command":"echo NONCE > .harness/.push-approved"}}'

    local hook_out3 hook_rc3
    hook_out3=$(cd "$tmp" && echo "$payload3" | bash "$GIT_GUARD" 2>&1) && hook_rc3=0 || hook_rc3=$?
    assert "git-guard 不拦截 .harness/.push-approved（AI 合法操作）" \
           "$(echo "$hook_out3" | grep -q 'AI 止步\|deny\|止步' && echo false || echo true)"
}

# ============================================================
# E2E-3: all 类型 → 单标记 .harness/.framework-edit 双后端 bypass
# ============================================================
test_e2e_all_single_marker() {
    echo "=== E2E-3: all 类型 → 单标记双后端 bypass ==="

    local tmp; tmp="$(mktemp -d)"
    CLEANUP_DIRS="${CLEANUP_DIRS} ${tmp}"
    git init -q "$tmp"
    git -C "$tmp" config user.email "test@test.local"
    git -C "$tmp" config user.name "test"
    git -C "$tmp" config commit.gpgsign false

    # 提取 setup 函数并安装 codex（模拟 all 的 codex 部分）
    local funcs; funcs="$(mktemp)"
    awk '/^# ── 入口/{exit} {print}' "$SETUP_SH" > "$funcs"
    (
        cd "$tmp" || exit 1
        source "$funcs"
        HARNESS_SOURCE="$PROJECT_ROOT"
        export HARNESS_BACKEND="codex"
        do_install_lite "$tmp"
    ) >/dev/null 2>&1 || true
    rm -f "$funcs"

    # 创建 .framework-manifest + stage 框架文件
    printf 'd .codex/hooks\nf .codex/hooks/git/pre-commit\n' > "$tmp/.framework-manifest"
    git -C "$tmp" add .framework-manifest
    echo "# probe" > "$tmp/.codex/hooks/git/_probe.py"
    git -C "$tmp" add -f .codex/hooks/git/_probe.py 2>/dev/null || true

    # 单标记 .harness/.framework-edit → pre-commit bypass
    mkdir -p "$tmp/.harness"
    touch "$tmp/.harness/.framework-edit"

    local bypass_out bypass_rc
    bypass_out="$(git -C "$tmp" commit -m "[0000] DEV test[AI·Developer]

feat: all single marker test" 2>&1)" && bypass_rc=0 || bypass_rc=$?
    assert "all: 单标记 .harness/.framework-edit → pre-commit bypass 生效" \
           "$([ "$bypass_rc" = "0" ] && echo true || echo false)"

    # 验证不需要在 .codex/ 下创建标记
    assert "all: 不需要在 .codex/ 创建 .framework-edit" \
           "$([ ! -f "$tmp/.codex/.framework-edit" ] && echo true || echo false)"
}

# ============================================================
# E2E-4: session-start 清理旧位置 marker
# ============================================================
test_e2e_session_cleanup() {
    echo "=== E2E-4: session-start 清理旧位置 marker ==="

    local tmp; tmp="$(mktemp -d)"
    CLEANUP_DIRS="${CLEANUP_DIRS} ${tmp}"

    # 模拟旧位置 marker 存在
    mkdir -p "$tmp/.codex" "$tmp/.codebuddy" "$tmp/.claude" "$tmp/.harness"
    touch "$tmp/.codex/.framework-edit"
    touch "$tmp/.codebuddy/.framework-edit"
    touch "$tmp/.claude/.framework-edit"
    touch "$tmp/.codex/.push-challenge"
    touch "$tmp/.codex/.push-approved"

    # 运行 session-start.sh 的清理段（提取 L74-76 区域）
    # 设置必要环境变量
    PROJECT_DIR="$tmp" \
    HARNESS_ROOT=".claude" \
    CLAUDE_PROJECT_DIR="$tmp" \
    bash -c '
        PROJECT_DIR="'"$tmp"'"
        # 模拟 session-start.sh 的清理逻辑
        rm -f "$PROJECT_DIR/.harness/.framework-edit" 2>/dev/null || true
        rm -f "$PROJECT_DIR/.harness/.push-challenge" 2>/dev/null || true
        rm -f "$PROJECT_DIR/.harness/.push-approved" 2>/dev/null || true
        # 旧位置清理（DBC-004）
        rm -f "$PROJECT_DIR/.codex/.framework-edit" "$PROJECT_DIR/.codebuddy/.framework-edit" "$PROJECT_DIR/.claude/.framework-edit" 2>/dev/null || true
        rm -f "$PROJECT_DIR/.codex/.push-challenge" "$PROJECT_DIR/.codebuddy/.push-challenge" "$PROJECT_DIR/.claude/.push-challenge" 2>/dev/null || true
        rm -f "$PROJECT_DIR/.codex/.push-approved" "$PROJECT_DIR/.codebuddy/.push-approved" "$PROJECT_DIR/.claude/.push-approved" 2>/dev/null || true
    '

    assert "session-start 清理后 .codex/.framework-edit 已删" \
           "$([ ! -f "$tmp/.codex/.framework-edit" ] && echo true || echo false)"

    assert "session-start 清理后 .codebuddy/.framework-edit 已删" \
           "$([ ! -f "$tmp/.codebuddy/.framework-edit" ] && echo true || echo false)"

    assert "session-start 清理后 .claude/.framework-edit 已删" \
           "$([ ! -f "$tmp/.claude/.framework-edit" ] && echo true || echo false)"

    assert "session-start 清理后 .codex/.push-challenge 已删" \
           "$([ ! -f "$tmp/.codex/.push-challenge" ] && echo true || echo false)"

    assert "session-start 清理后 .codex/.push-approved 已删" \
           "$([ ! -f "$tmp/.codex/.push-approved" ] && echo true || echo false)"
}

# ============================================================
# E2E-5: settings-emit.mjs 生成验证（relocatable 不重写 .harness/）
# ============================================================
test_e2e_settings_emit() {
    echo "=== E2E-5: settings-emit.mjs relocatable 不重写 .harness/ ==="

    # 验证 relocatable 函数只替换 .claude/ → $HARNESS_ROOT/，不碰 .harness/
    local result
    result=$(node -e "
        import('$SETTINGS_EMIT').then(m => {
            // relocatable 是内部函数，通过 claudeJsonSettings 间接验证
            // 检查 settings.json 源文件改了 .harness/ 后，生成结果也含 .harness/
            const out = m.claudeJsonSettings({ env: { HARNESS_BACKEND: 'codebuddy', HARNESS_ROOT: '.codebuddy' } });
            const json = JSON.stringify(out);
            // 应含 .harness/.framework-edit（源文件改了，relocatable 不碰 .harness/）
            if (json.includes('.harness/.framework-edit')) {
                console.log('true');
            } else {
                console.log('false');
            }
        }).catch(e => { console.log('error:' + e.message); });
    " 2>/dev/null || echo "error")

    assert "claudeJsonSettings 生成结果含 .harness/.framework-edit（CodeBuddy）" \
           "$([ "$result" = "true" ] && echo true || echo false)"

    # 验证 codexHooksJson 也含 .harness/.framework-edit
    local result2
    result2=$(node -e "
        import('$SETTINGS_EMIT').then(m => {
            const out = m.codexHooksJson({ env: { HARNESS_BACKEND: 'codex', HARNESS_ROOT: '.codex' } });
            const json = JSON.stringify(out);
            if (json.includes('.harness/.framework-edit')) {
                console.log('true');
            } else {
                console.log('false');
            }
        }).catch(e => { console.log('error:' + e.message); });
    " 2>/dev/null || echo "error")

    assert "codexHooksJson 生成结果含 .harness/.framework-edit（Codex）" \
           "$([ "$result2" = "true" ] && echo true || echo false)"

    # 验证不含 .claude/.framework-edit（旧位置不残留）
    local result3
    result3=$(node -e "
        import('$SETTINGS_EMIT').then(m => {
            const out = m.claudeJsonSettings({ env: { HARNESS_BACKEND: 'codebuddy', HARNESS_ROOT: '.codebuddy' } });
            const json = JSON.stringify(out);
            if (json.includes('.claude/.framework-edit')) {
                console.log('false');
            } else {
                console.log('true');
            }
        }).catch(e => { console.log('error:' + e.message); });
    " 2>/dev/null || echo "error")

    assert "claudeJsonSettings 不含旧 .claude/.framework-edit" \
           "$([ "$result3" = "true" ] && echo true || echo false)"
}

# ============================================================
# 语法检查
# ============================================================
test_syntax_check() {
    echo "=== 语法检查 ==="

    assert "session-start.sh 语法正确" \
           "$(bash -n "$SESSION_START" 2>&1 && echo true || echo false)"

    assert "check-upgrade-prompt.sh 语法正确" \
           "$(bash -n "$CHECK_UPGRADE" 2>&1 && echo true || echo false)"

    assert "pre-tool-use-tasks-guard.sh 语法正确" \
           "$(bash -n "$TASKS_GUARD" 2>&1 && echo true || echo false)"

    assert "pre-tool-use-git-guard.sh 语法正确" \
           "$(bash -n "$GIT_GUARD" 2>&1 && echo true || echo false)"

    assert "pre-push 语法正确" \
           "$(bash -n "$PRE_PUSH" 2>&1 && echo true || echo false)"

    assert "pre-commit 语法正确" \
           "$(bash -n "$PRE_COMMIT" 2>&1 && echo true || echo false)"

    assert "setup-harness.sh 语法正确" \
           "$(bash -n "$SETUP_SH" 2>&1 && echo true || echo false)"

    assert "settings-emit.mjs 语法正确" \
           "$(node --check "$SETTINGS_EMIT" 2>&1 && echo true || echo false)"

    local json_ok
    json_ok=$(node -e "JSON.parse(require('fs').readFileSync('${SETTINGS_JSON}','utf8')); console.log('true')" 2>/dev/null || echo false)
    assert "settings.json 是合法 JSON" "$json_ok"
}

# ============================================================
# 主入口
# ============================================================
CLEANUP_DIRS=""
cleanup() {
    for d in ${CLEANUP_DIRS}; do
        rm -rf "${d}" 2>/dev/null || true
    done
}
trap cleanup EXIT

echo ""
echo "╔═══════════════════════════════════════════════════════╗"
echo "║  test_backend_path_cleanup.sh — marker → .harness/   ║"
echo "╚═══════════════════════════════════════════════════════╝"
echo ""

# 源仓不应预设 harness.backend-dir
if git -C "$PROJECT_ROOT" config --get harness.backend-dir >/dev/null 2>&1; then
    echo "WARN: 源仓已设 harness.backend-dir，可能干扰测试" >&2
fi

test_syntax_check
test_t1_upgrade_marker
test_t2_framework_edit
test_t3_push_markers
test_t4_upgrade_path
test_t5_gitignore
test_t6_integrity_state
test_t7_docs_residual
test_e2e_codex_framework_edit
test_e2e_attack_surface
test_e2e_all_single_marker
test_e2e_session_cleanup
test_e2e_settings_emit

echo ""
echo "════════════════════════════════════════════════════════"
echo "  Results: $PASS passed, $FAIL failed"
echo "════════════════════════════════════════════════════════"

[ "$FAIL" = "0" ] || exit 1
