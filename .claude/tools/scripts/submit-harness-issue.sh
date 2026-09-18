#!/usr/bin/env bash
# 下游项目向 Uni-AURI 框架提交 issue
# 由下游 AI 调用，自动收集上下文并提交
set -euo pipefail

TITLE="${1:-}"
SUMMARY="${2:-}"
STDERR_FILE="${3:-/dev/null}"

if [ -z "$TITLE" ] || [ -z "$SUMMARY" ]; then
  echo "Usage: $0 <title> <summary> [stderr-log]" >&2
  exit 1
fi

# ── 收集上下文 ──
FRAMEWORK_VERSION=$(cat .harness/.harness-version 2>/dev/null | head -1 || echo "unknown")
PROJECT_NAME=$(basename "$(pwd)")
# 脱敏：剥离 URL 中的 credentials（http(s)://user:pass@host → http(s)://host），
# 避免 issue 描述泄漏 PAT（issue !190 下游反馈：token 被原样写入 Git 仓库字段）
GIT_REMOTE=$(git remote get-url origin 2>/dev/null | sed -E 's#(://)[^/@]*@#\1#' || true)
[ -z "$GIT_REMOTE" ] && GIT_REMOTE="unknown"
GIT_BRANCH=$(git branch --show-current 2>/dev/null || echo "unknown")
OS_INFO="$(uname -s) $(uname -m)"
# AI 调用方在调用前 export CLAUDE_MODEL（如 export CLAUDE_MODEL="glm-5.2"），
# 否则降级到 ANTHROPIC_MODEL（Claude Code 原生变量），都没有则显示 unknown。
MODEL_INFO="${CLAUDE_MODEL:-${ANTHROPIC_MODEL:-unknown}}"

# 最近 3 条框架相关 commit
RECENT_COMMITS=$(git log --oneline -3 -- .claude/ .harness/ 2>/dev/null || echo "none")

# stderr 日志（如有）
STDERR_LOG=""
if [ -f "$STDERR_FILE" ] && [ -s "$STDERR_FILE" ]; then
  STDERR_LOG=$(tail -50 "$STDERR_FILE" 2>/dev/null || echo "")
fi

# ── 构建 issue 描述 ──
DESCRIPTION=$(cat <<MARKDOWN
## 问题描述

$SUMMARY

## 环境信息

| 项目 | 值 |
|------|------|
| 框架版本 | $FRAMEWORK_VERSION |
| 项目名 | $PROJECT_NAME |
| Git 仓库 | $GIT_REMOTE |
| 分支 | $GIT_BRANCH |
| 模型 | $MODEL_INFO |
| OS | $OS_INFO |

## 框架相关最近提交

\`\`\`
$RECENT_COMMITS
\`\`\`

$(if [ -n "$STDERR_LOG" ]; then echo "## 相关日志 (stderr)"; echo ""; echo '```'; echo "$STDERR_LOG"; echo '```'; fi)

---
> 由 AI 自动提交 · $(date -Iseconds)
MARKDOWN
)

# ── 获取提交者身份与 token ──
GITLAB_URL="http://192.168.5.160"
PROJECT_ID="public_group%2Frd_harness"

# Token: 必须由下游项目提供，用于标识提交者身份
TOKEN="${GITLAB_TOKEN:-}"
if [ -z "$TOKEN" ]; then
  TOKEN=$(sed -n 's/^gitlab_token=//p' .gitlab-config 2>/dev/null | head -1 || echo "")
fi

if [ -z "$TOKEN" ]; then
  echo "" >&2
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" >&2
  echo "  框架反馈通道" >&2
  echo "  向 Uni-AURI 框架提交 bug / 优化建议" >&2
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" >&2
  echo "" >&2
  echo "  当前缺少 GitLab Token，自动提交未成功。" >&2
  echo "  设置 Token 后重试：" >&2
  echo "    export GITLAB_TOKEN=<your-token>" >&2
  echo "    或写入 .gitlab-config: gitlab_token=<your-token>" >&2
  echo "" >&2
  echo "  也可手动提交到：" >&2
  echo "    ${GITLAB_URL}/public_group/rd_harness/-/issues/new" >&2
  echo "" >&2
  echo "  标题: $TITLE" >&2
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" >&2
  exit 1
fi

# 解析提交者身份（通过 GitLab API 查 token 对应的用户）
# 注意：用 process.stdin 流式读取，而非 readFileSync('/dev/stdin') —— 后者在 Windows
# 下 node 会把 /dev/stdin 当普通路径解析为 E:\dev\stdin → ENOENT（issue !112）
SUBMITTER=$(curl -s "${GITLAB_URL}/api/v4/user" \
  -H "PRIVATE-TOKEN: ${TOKEN}" | node -e '
let d="";
process.stdin.on("data", c => d += c).on("end", () => {
  try {
    const u = JSON.parse(d);
    if (u.error) return;
    if (typeof u.username === "string" && typeof u.name === "string") {
      console.log(u.username + " (" + u.name + ")");
    }
  } catch (e) {}
})' 2>/dev/null || echo "unknown")
[ -z "$SUBMITTER" ] && SUBMITTER="unknown"

# 在描述头部追加提交者信息
DESCRIPTION=$(cat <<MARKDOWN
> 提交者: $SUBMITTER | 项目: $PROJECT_NAME | 分支: $GIT_BRANCH

$DESCRIPTION
MARKDOWN
)

# 构造 JSON payload 到临时文件，避免 node -e 命令行参数传递多行/特殊字符
# 在 Windows Git Bash 等环境下，内联 bash 变量容易破坏 JSON（issue !129）
PAYLOAD_FILE=$(mktemp)
trap 'rm -f "$PAYLOAD_FILE"' EXIT

SUBMIT_TITLE="$TITLE" SUBMIT_DESC="$DESCRIPTION" PAYLOAD_FILE="$PAYLOAD_FILE" node -e '
const fs = require("fs");
const title = process.env.SUBMIT_TITLE;
const desc = process.env.SUBMIT_DESC;
const payload = {title, description: desc, labels: "ai-detected,from-downstream"};
fs.writeFileSync(process.env.PAYLOAD_FILE, JSON.stringify(payload));
' 2>/dev/null

RESPONSE=$(curl -s -X POST "${GITLAB_URL}/api/v4/projects/${PROJECT_ID}/issues" \
  -H "PRIVATE-TOKEN: ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d "@$PAYLOAD_FILE" 2>&1)

IID=$(echo "$RESPONSE" \
  | node -e '
let d="";
process.stdin.on("data", c => d += c).on("end", () => {
  try {
    const r = JSON.parse(d);
    if (r.error) {
      console.error("API error: " + r.error + (r.error_description ? " - " + r.error_description : ""));
      process.exit(1);
    }
    if (typeof r.iid === "number") console.log(r.iid);
  } catch (e) {}
})' 2>/dev/null)

if [ -n "$IID" ] && [ "$IID" != "null" ]; then
  echo "[submit-harness-issue] Created: ${GITLAB_URL}/public_group/rd_harness/-/issues/${IID}"
else
  echo "[submit-harness-issue] API 提交失败，请手动提交到 ${GITLAB_URL}/public_group/rd_harness/-/issues/new" >&2
  echo "--- 标题 ---" >&2
  echo "$TITLE" >&2
  echo "--- 描述 ---" >&2
  echo "$DESCRIPTION" >&2
  exit 1
fi
