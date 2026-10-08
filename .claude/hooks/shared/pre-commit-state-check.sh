#!/usr/bin/env bash
# PreToolUse hook: git commit 前校验
# 职责：GATE_BYPASS Challenge-Response 验证
# 格式校验已迁移到 git commit-msg hook（.claude/hooks/git/commit-msg）
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/hook-json-helper.sh"

# issue !308：带超时读 stdin；超时/读失败 fail-open（放行好过阻塞工具调用 60s）
INPUT=$(hook_read_stdin) || {
    echo "[state-check] stdin 读取超时/失败，fail-open 放行（issue !308）" >&2
    exit 0
}
COMMAND=$(_jq_raw "$INPUT" command)

# 只拦截 git commit
if ! echo "$COMMAND" | grep -qE '(^|&&|\||\;|\s)git\s+commit\b'; then
    exit 0
fi

PROJECT_DIR="${QODER_PROJECT_DIR:-${CLAUDE_PROJECT_DIR:-${REPO_ROOT:-.}}}"

deny() {
    hook_deny "$1"
    exit 0
}

# ── GATE_BYPASS 校验已迁移 ──
# 原职责：Challenge-Response 验证。但 PreToolUse hook 在 git commit 命令执行前触发，
# 此时 .git/COMMIT_EDITMSG 尚未生成，本段永不命中（校验/deny 分支从不执行，Issue !246）。
# 校验已迁移到 git commit-msg hook（$1 即 message 文件，时序可靠，且负责任务单次消费）。
# 本段保留空转；如需恢复校验，以 commit-msg 为准，勿在此重复。

exit 0
