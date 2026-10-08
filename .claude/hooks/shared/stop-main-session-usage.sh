#!/usr/bin/env bash
# Stop hook: 主会话直出用量采集（Issue !279；codex 直采 Issue #288）
# 背景：usage.jsonl 由 PostToolUse(Agent|Task) 落盘，只覆盖「有 dispatch」的场景；
#   natural 模式主会话直出的 token 从不进「AI 员工调度统计」，日报忽有忽无。
# 机制：每次 Stop（一轮主会话结束）取 transcript 自上次偏移以来的 assistant 用量，
#   经 record-usage 落一条 role=main-session / trigger=main 记录；偏移文件按
#   session 隔离，record-usage 内部用与提取同一度量回写行数（--advance-offset-file），
#   避免 hook 侧行数口径漂移。无新行时 record-usage 自行 skip，不产生空记录。
# codex（#288）：主会话 rollout（~/.codex/sessions/YYYY/MM/DD/rollout-*-{sid}.jsonl）
#   无 Claude transcript 布局，按同一偏移机制走 record-usage --rollout-file 直采。
# 口径（PM 确认）：main 记录在日报调度统计表单列展示，不计入 dispatch_count。
# 失败静默（exit 0）——hook 异常不得阻塞会话结束。
# 范围：claude/codex track；qoder/zcode 主会话直采留 follow-up。
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./hook-json-helper.sh
source "$SCRIPT_DIR/hook-json-helper.sh"

INPUT=$(cat)
SID=$(_jq_val "$INPUT" session_id)
TRANSCRIPT=$(_jq_val "$INPUT" transcript_path)

[ -z "$SID" ] && exit 0

# usage 目录与 cli-commands.getUsageFile 同规则：HARNESS_USAGE_DIR（可能含字面 $HOME）优先。
# 本块在 transcript 检查之前——codex Stop payload 无 transcript_path，偏移文件两轨共用。
USAGE_DIR="${HARNESS_USAGE_DIR:-}"
[ -n "$USAGE_DIR" ] && USAGE_DIR="$(_expand_home "$USAGE_DIR")"
[ -z "$USAGE_DIR" ] && USAGE_DIR="$HOME/.claude/usage"
mkdir -p "$USAGE_DIR" 2>/dev/null || exit 0
OFFSET_FILE="$USAGE_DIR/.main-offset-$SID"
FROM_LINE=0
[ -f "$OFFSET_FILE" ] && FROM_LINE=$(tr -dc '0-9' < "$OFFSET_FILE" 2>/dev/null || echo 0)
[ -z "$FROM_LINE" ] && FROM_LINE=0

# ── codex 主会话直采（Issue #288）：rollout 布局，无 Claude transcript ──
if [ "${HARNESS_BACKEND:-}" = "codex" ]; then
  # rollout_path 优先（payload 直供），缺失时按 session id 在 sessions 树定位
  # （rollout 文件名尾段即会话 id；同 id 多文件取最新——sort|tail）
  ROLLOUT="$(_jq_val "$INPUT" rollout_path)"
  if [ -z "$ROLLOUT" ]; then
    CODEX_ROOT="${CODEX_HOME:-$HOME/.codex}"
    ROLLOUT=$(find "$CODEX_ROOT/sessions" -type f -name "rollout-*-${SID}.jsonl" 2>/dev/null | sort | tail -1)
  fi
  [ -z "$ROLLOUT" ] && exit 0
  [ -f "$ROLLOUT" ] || exit 0
  # 快速预检（同 claude track）：行数未超过偏移则直接退出，省一次 node 冷启动
  LINES=$(awk 'END{print NR}' "$ROLLOUT" 2>/dev/null || echo 0)
  [ "${LINES:-0}" -le "$FROM_LINE" ] && exit 0
  PROJECT_DIR="${QODER_PROJECT_DIR:-${CLAUDE_PROJECT_DIR:-${REPO_ROOT:-.}}}"
  HARNESS_ROOT_DIR="${HARNESS_ROOT:-}"
  ORCH="$PROJECT_DIR/$HARNESS_ROOT_DIR/skills/rd-auto/scripts/orchestrator.js"
  [ -f "$ORCH" ] || exit 0
  # record-usage 侧 session_id 取自 CLAUDE_CODE_SESSION_ID（codex 不注入，需显式 export）
  export CLAUDE_CODE_SESSION_ID="$SID"
  node "$ORCH" record-usage \
    --role main-session \
    --trigger main \
    --task "main-session:${SID:0:8}" \
    --backend codex \
    --rollout-file "$ROLLOUT" \
    --from-line "$FROM_LINE" \
    --advance-offset-file "$OFFSET_FILE" \
    >/dev/null 2>&1 || true
  exit 0
fi

# ── claude track：transcript 增量提取（原 !279 逻辑）──
[ -z "$TRANSCRIPT" ] && exit 0
[ ! -f "$TRANSCRIPT" ] && exit 0

# 快速预检：行数未超过偏移则直接退出，省一次 node 冷启动。
# awk END{NR} 兼容末行无换行符；与 countTranscriptLines 的偏差只会偏小，
# 由 record-usage 内部权威行数推进自纠正。
LINES=$(awk 'END{print NR}' "$TRANSCRIPT" 2>/dev/null || echo 0)
[ "${LINES:-0}" -le "$FROM_LINE" ] && exit 0

PROJECT_DIR="${QODER_PROJECT_DIR:-${CLAUDE_PROJECT_DIR:-.}}"
ORCH="$PROJECT_DIR/.claude/skills/rd-auto/scripts/orchestrator.js"
[ -f "$ORCH" ] || exit 0

node "$ORCH" record-usage \
  --role main-session \
  --trigger main \
  --task "main-session:${SID:0:8}" \
  --from-line "$FROM_LINE" \
  --advance-offset-file "$OFFSET_FILE" \
  >/dev/null 2>&1 || true

exit 0
