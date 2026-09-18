#!/usr/bin/env bash
# PostToolUse hook: 自动记录 Agent dispatch 的 usage
# 触发条件: Task / Agent 工具执行完毕后
# 输出: 调用 orchestrator.js record-usage 追加到 .harness/usage/usage.jsonl
# 注：不用 set -e，任何子命令失败也不应导致 hook 整体以非零退出。
# hook runner 可能直接取进程退出码，|| true 在外层未必能拦截。
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/hook-json-helper.sh"

PROJECT_DIR="${QODER_PROJECT_DIR:-${CLAUDE_PROJECT_DIR:-${REPO_ROOT:-.}}}"
# 框架根目录（默认即本 agent 目录；generator 注入 HARNESS_ROOT 让其它 agent 复用同一框架目录）
HARNESS_ROOT="${HARNESS_ROOT:-}"
# 用户级 transcript / usage 目录（默认 ~/.claude；codex/codebuddy/qoder 通过 HARNESS_* 注入）。
# HARNESS_PROJECTS_DIR / HARNESS_USAGE_DIR 由 generator 注入，可能含字面 `$HOME`（settings.json
# 的 env 块写 "$HOME/.codebuddy/usage"，bash 不展开单引号内的 $HOME）。用 _expand_home（定义在
# hook-json-helper.sh）展开为 $HOME 真实值，与 orchestrator.js 的 `.replace(/\$HOME/g, homedir())`
# 对齐，否则 mkdir -p '$HOME/...' 会在 CWD 下创建字面 `$HOME` 目录。
PROJECTS_DIR="${HARNESS_PROJECTS_DIR:-$HOME/${HARNESS_ROOT:-}/projects}"
PROJECTS_DIR="$(_expand_home "$PROJECTS_DIR")"

# ── 读取 stdin JSON ──
INPUT=$(cat)

# ── 防御性过滤：只处理 Task / Agent 工具 ──
TOOL=$(_jq_val "$INPUT" tool_name)
case "$TOOL" in
    Task|Agent) ;;
    *) exit 0 ;;
esac

# ── 提取 subagent_type，为空则退出 ──
SUBAGENT_TYPE=$(_jq_raw "$INPUT" subagent_type)
[ -z "$SUBAGENT_TYPE" ] && exit 0

# ── 映射角色名（与 usage-tracking.md 角色名映射表一致） ──
case "$SUBAGENT_TYPE" in
    Architect)  ROLE="architect" ;;
    Developer)  ROLE="developer" ;;
    Tester)     ROLE="tester" ;;
    Reviewer)   ROLE="reviewer" ;;
    Debate)     ROLE="debate" ;;
    *)          ROLE="$(echo "$SUBAGENT_TYPE" | tr '[:upper:]' '[:lower:]')" ;;
esac

# ── 提取 task 描述（从 prompt 截取前 100 字符，过滤敏感词） ──
TASK_PROMPT=$(_jq_raw "$INPUT" prompt)
TASK_DESC=""
if [ -n "$TASK_PROMPT" ]; then
    TASK_DESC="$(printf '%s' "$TASK_PROMPT" | head -c 100 | tr '\n' ' ' \
        | sed -E 's/(api[_-]?key|password|secret|token|credential|auth)[=:]["'"'"']?[[:alnum:]_\-]{6,}/\1=***REDACTED***/gi')"
fi

# ── Transcript 水位线管理（per-project + per-session 隔离） ──
# !150: 旧实现用全局 .last-transcript-line，多项目共享时水位线被其他项目推到几万行之外，
# 导致 extractTokenUsage 从超大 line 开始读 transcript（实际才几百行）→ 读不到 usage → tokens=null。
# 修复：水位线文件名按 (project_slug, session_id) 隔离，跨项目/跨 session 互不污染。
USAGE_DIR="${HARNESS_USAGE_DIR:-$HOME/${HARNESS_ROOT:-}/usage}"
USAGE_DIR="$(_expand_home "$USAGE_DIR")"

# 路径编码规则：所有非字母数字字符替换为 "-"，必须与 orchestrator.js findTranscriptPath() 保持一致
SESSION_ID=$(_jq_val "$INPUT" session_id)
_project_slug="$(echo "$PROJECT_DIR" | sed 's/[^a-zA-Z0-9]/-/g')"

WATERMARK_FILE="$USAGE_DIR/.last-line-${_project_slug}-${SESSION_ID:-no-session}"
FROM_LINE="0"
if [ -f "$WATERMARK_FILE" ]; then
    FROM_LINE="$(cat "$WATERMARK_FILE" 2>/dev/null || echo 0)"
fi

# 计算当前 transcript 路径
# CodeBuddy 与 Claude Code 的 slug 规则不同（去前导 `-`、保留 `_`），直接按
# project_slug 精确匹配会失配。改为按 sessionId 在 PROJECTS_DIR 各子目录全局搜，
# sessionId 唯一，定位准确。
_transcript_path=""
if [ -n "$SESSION_ID" ] && [ -d "$PROJECTS_DIR" ]; then
    while IFS= read -r _proj_dir; do
        _candidate="$_proj_dir/${SESSION_ID}.jsonl"
        if [ -f "$_candidate" ]; then
            _transcript_path="$_candidate"
            break
        fi
    done < <(find "$PROJECTS_DIR" -mindepth 1 -maxdepth 1 -type d 2>/dev/null)
fi

# 更新水位线为当前 transcript 行数（下一次 dispatch 的起点）
if [ -n "$_transcript_path" ]; then
    _current_lines="$(wc -l < "$_transcript_path" 2>/dev/null || echo 0)"
    mkdir -p "$USAGE_DIR" 2>/dev/null || true
    printf '%s' "$_current_lines" > "$WATERMARK_FILE"
fi

# ── 提取 started_at ──
# 优先级 1：Claude Code 的 duration_ms 字段（反算 started_at）
# 优先级 2：PreToolUse 配对 hook 写入的 .pending-<call_id>（CodeBuddy Code 无 duration_ms 时走此路径）
# 用 _jq_raw（node 解析）而非 _jq_val（sed）：duration_ms 是数字类型，sed 只能匹配引号字符串
DURATION_MS=$(_jq_raw "$INPUT" duration_ms)
CALL_ID=$(_jq_val "$INPUT" call_id)
[ -z "$CALL_ID" ] && CALL_ID=$(_jq_val "$INPUT" tool_use_id)
STARTED_AT_FLAG=""
STARTED_AT=""
if [ -n "$DURATION_MS" ] && [ "$DURATION_MS" != "0" ]; then
    # 通过 stdin 传值（避免 node -e 中拼接变量的注入风险），兼容 macOS/Linux
    STARTED_AT="$(printf '%s' "$DURATION_MS" | node -e "
        let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{
            const ms=parseInt(d.trim(),10);
            if(!isNaN(ms)&&ms>0)process.stdout.write(new Date(Date.now()-ms).toISOString());
        });
    " 2>/dev/null || true)"
fi
# duration_ms 缺失时，从 PreToolUse 配对 hook 写入的 pending 文件读 started_at
if [ -z "$STARTED_AT" ] && [ -n "$CALL_ID" ]; then
    _PENDING="$USAGE_DIR/.pending-${CALL_ID}"
    if [ -f "$_PENDING" ]; then
        STARTED_AT="$(cat "$_PENDING" 2>/dev/null)"
        rm -f "$_PENDING" 2>/dev/null || true
    fi
fi
[ -n "$STARTED_AT" ] && STARTED_AT_FLAG="--started-at"

# ── 调用 orchestrator.js record-usage ──
# --completed-at 省略（自动取当前时间）
# --started-at 从 duration_ms 反算
# --from-line 使用水位线增量提取 token
# --backend 显式 claude（P2-001：此 hook 只在 Claude 路径触发；
#   codex dispatch 走 codex exec 子进程，不触发 PostToolUse:Agent。
#   显式传 --backend claude 比 record-usage 内部从环境变量推断更准确）
# stdout 静默，stderr 写入错误日志便于排查（不超过 10KB，自动清理）
# 确保 USAGE_DIR 存在：否则 2>>$_ERR_LOG 重定向会因父目录缺失而失败，错误被 || true 静默吞掉
mkdir -p "$USAGE_DIR" 2>/dev/null || true
# 把 session_id 注入为 CLAUDE_CODE_SESSION_ID：orchestrator.js 的 findTranscriptPath() 依赖它定位 transcript。
# CodeBuddy Code 不设此 env，hook 从输入 JSON 提取后需显式 export 给 node 子进程。
[ -n "$SESSION_ID" ] && export CLAUDE_CODE_SESSION_ID="$SESSION_ID"
_ERR_LOG="$USAGE_DIR/.hook-error.log"
if [ -f "$_ERR_LOG" ] && [ "$(wc -c < "$_ERR_LOG" 2>/dev/null || echo 0)" -gt 10240 ]; then
    : > "$_ERR_LOG"
fi
if [ -n "$STARTED_AT_FLAG" ]; then
    node "$PROJECT_DIR/$HARNESS_ROOT/skills/rd-auto/scripts/orchestrator.js" \
        record-usage \
        --role "$ROLE" \
        --trigger natural \
        --backend "${HARNESS_BACKEND:-claude}" \
        --task "$TASK_DESC" \
        --started-at "$STARTED_AT" \
        --from-line "$FROM_LINE" \
        >/dev/null 2>>"$_ERR_LOG" || true
else
    node "$PROJECT_DIR/$HARNESS_ROOT/skills/rd-auto/scripts/orchestrator.js" \
        record-usage \
        --role "$ROLE" \
        --trigger natural \
        --backend "${HARNESS_BACKEND:-claude}" \
        --task "$TASK_DESC" \
        --from-line "$FROM_LINE" \
        >/dev/null 2>>"$_ERR_LOG" || true
fi

exit 0
