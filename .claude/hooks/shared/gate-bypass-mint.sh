#!/usr/bin/env bash
# gate-bypass-mint.sh — 铸造 GATE_BYPASS Challenge NONCE（pm_override 流程 step 4）
# 用法: bash gate-bypass-mint.sh <TASK-ID> <PM_ID> <GATE_ID> '<reason>'
# 产出: .harness/.bypass-challenge（NONCE|TASK_ID|PM_ID|GATE_ID|HEAD_HASH|TIMESTAMP）
# 消费: commit-msg hook 校验 Challenge-Response 并单次消费（见 .claude/hooks/git/commit-msg）
set -euo pipefail

[ $# -ge 3 ] || {
    echo "用法: $0 <TASK-ID> <PM_ID> <GATE_ID> '<reason>'" >&2
    exit 1
}

TASK_ID="$1"
PM_ID="$2"
GATE_ID="$3"
REASON="${4:-}"

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
CHALLENGE="$REPO_ROOT/.harness/.bypass-challenge"
APPROVE="$REPO_ROOT/.claude/.bypass-approved"

NONCE="$(od -An -tx1 -N4 /dev/urandom | tr -d ' \n')"
HEAD_HASH="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
TIMESTAMP="$(date +%s)"

printf '%s|%s|%s|%s|%s|%s' "$NONCE" "$TASK_ID" "$PM_ID" "$GATE_ID" "$HEAD_HASH" "$TIMESTAMP" > "$CHALLENGE"

echo "GATE_BYPASS NONCE 已铸造: $NONCE"
echo "challenge: $CHALLENGE"
[ -n "$REASON" ] && echo "reason: $REASON"
echo "下一步（PM 确认后）: echo '$NONCE' > $APPROVE"