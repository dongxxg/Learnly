#!/usr/bin/env bash
# PreToolUse hook: tasks/shared-state 危险命令守卫 (Issue !163)
#
# 背景：sub-agent 跑 git reset --hard + git clean -fd 组合时，
# clean 会删掉 untracked 的 .harness/tasks/<change>/ 目录，丢失 pipeline-state。
# settings.json 的 deny list 在 defaultMode: bypassPermissions 下可能被绕过，
# 因此加 PreToolUse hook 做更可靠的拦截。
#
# 拦截规则（任一命中即拒绝）：
#   1) git clean（任何形式：-f / -fd / -fdx / -X 等）
#   2) git reset --hard
#   3) rm -rf 且路径含 .harness/tasks 或 .harness/shared-state
#   4) find + (-delete 或 -exec rm 或 -execdir rm) 且路径含 .harness/tasks
#
# 白名单：.harness/.framework-edit 存在时跳过（PM 授权场景，避免双重拦截）
#
# 阻断方式：exit 2 + stderr 反馈给模型（Claude Code hook 规范）
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/hook-json-helper.sh"

INPUT=$(cat)
TOOL=$(_jq_val "$INPUT" tool_name)

case "$TOOL" in
    Bash) ;;
    *) exit 0 ;;
esac

# bypass：PM 授权场景（与现有 hook 一致）
if [ -f .harness/.framework-edit ]; then
    exit 0
fi

COMMAND=$(_jq_val "$INPUT" command)
# tool_input.command 兜底（_jq_val 只看顶层，hook-json-helper 的 _jq_raw 才看 tool_input）
if [ -z "$COMMAND" ]; then
    COMMAND=$(_jq_raw "$INPUT" command)
fi

# 如果还是空（异常情况），不拦截交给后续 hook 处理
if [ -z "$COMMAND" ]; then
    exit 0
fi

DENY_REASON=""

# ── 规则 1: git clean（任何形式） ──
# 形态：git clean -f / -fd / -fdx / -X / -d / -x 等组合
if echo "$COMMAND" | grep -qE '(^|[[:space:]]|;|&&|\|)git[[:space:]]+clean([[:space:]]|$)'; then
    DENY_REASON="git clean 会删除 untracked 文件，可能清空 .harness/tasks/<change>/ 目录"
fi

# ── 规则 2: git reset --hard ──
if [ -z "$DENY_REASON" ]; then
    if echo "$COMMAND" | grep -qE '(^|[[:space:]]|;|&&|\|)git[[:space:]]+reset[[:space:]]+--hard([[:space:]]|$)'; then
        DENY_REASON="git reset --hard 会丢弃工作区改动并可能配合 clean 删除 untracked"
    fi
fi

# ── 规则 3: rm -rf 且路径含 .harness/tasks 或 .harness/shared-state ──
if [ -z "$DENY_REASON" ]; then
    if echo "$COMMAND" | grep -qE 'rm[[:space:]]+(-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*|-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*|--recursive)' \
       && echo "$COMMAND" | grep -qE '\.harness/(tasks|shared-state)([[:space:]]|/|$)'; then
        DENY_REASON="rm -rf 删除 .harness/tasks 或 .harness/shared-state 会丢失 pipeline-state"
    fi
fi

# ── 规则 4: find + (-delete 或 -exec rm 或 -execdir rm) 且路径含 .harness/tasks ──
if [ -z "$DENY_REASON" ]; then
    if echo "$COMMAND" | grep -qE 'find[[:space:]].*\.harness/tasks([[:space:]]|/|$)' \
       && echo "$COMMAND" | grep -qE '(-delete|-exec[[:space:]]+rm|-execdir[[:space:]]+rm)'; then
        DENY_REASON="find 删除 .harness/tasks 下的文件会丢失 pipeline-state"
    fi
fi

# ── 命中规则：阻断 ──
if [ -n "$DENY_REASON" ]; then
    cat >&2 <<EOF
🚫 检测到危险命令，已拦截（issue !163 防御）：
   命令: ${COMMAND}
   原因: ${DENY_REASON}
   修复: 如需清理 .harness/tasks/<change>/，请用：
     node .claude/skills/rd-auto/scripts/orchestrator.js complete <change>
   或在 mark-dispatch --end 后由 PM 决定是否手动清理。
   如确需绕过（仅框架源仓 PM 授权场景），创建 .harness/.framework-edit 标记。
EOF
    # 同时输出 JSON deny（兼容 permissionDecision 路径），然后 exit 2 硬阻断
    hook_deny "issue !163 防御：${DENY_REASON}" >/dev/null 2>&1 || true
    exit 2
fi

exit 0
