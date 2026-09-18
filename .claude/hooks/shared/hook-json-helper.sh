#!/usr/bin/env bash
# hook-json-helper.sh — JSON utilities for Claude Code hooks
# Replaces jq with sed (fast path) and node (full path)
# Compatible with Linux, macOS, and Windows (Git Bash)
# Usage: source "$(dirname "$0")/hook-json-helper.sh"

# ── Cross-platform HOME fallback ──
# Git Bash on Windows sets $HOME, but native cmd/PowerShell does not.
# os.homedir() reads $HOME first on POSIX; must delete it to force OS-level lookup.
if [ -z "${HOME:-}" ]; then
    HOME="$(node -e "delete process.env.HOME;process.stdout.write(require('os').homedir())" 2>/dev/null || echo "/tmp")"
    export HOME
fi

# Fast path: extract simple single-line string value (sed-based)
# Works for tool_name, short commands, file_path, etc.
# Returns empty string if key not found.
_jq_val() {
    printf '%s' "$1" | sed -n 's/.*"'"$2"'"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1
}

# Full path: extract value with proper JSON unescaping (node-based)
# Handles multiline values, escaped quotes, etc.
# Checks both top-level and tool_input-level for the key.
_jq_raw() {
    printf '%s' "$1" | node -e "
        let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{
            try{
                const o=JSON.parse(d);
                let v=o['$2'];
                if(v==null&&o.tool_input)v=o.tool_input['$2'];
                if(v!=null)process.stdout.write(String(v));
            }catch(e){}
        })
    " 2>/dev/null || true
}

# Output PreToolUse deny response (handles JSON escaping)
# 退出码受 HOOK_DENY_EXIT 控制：
#   - 默认 0（Claude Code 读 JSON 决策即可拦截）
#   - CodeBuddy/Codex/ZCode 需要通过 exit 2 表示阻断（见 hooks spec），由 generator 注入 HOOK_DENY_EXIT=2
hook_deny() {
    local r="$1" e=""
    e="${r//\\/\\\\}"
    e="${e//\"/\\\"}"
    e="${e//$'\n'/\\n}"
    e="${e//$'\r'/\\r}"
    e="${e//$'\t'/\\t}"
    printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\n' "$e"
    exit ${HOOK_DENY_EXIT:-0}
}

# Output PreToolUse allow response
hook_allow() {
    printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}\n'
}

# ── Expand literal $HOME / $USERPROFILE in env-injected paths ──
# generator 把 HARNESS_PROJECTS_DIR / HARNESS_USAGE_DIR 注入到 settings.json env 块时，
# 值是字面 "$HOME/..."（bash 不展开单引号 env 值里的 $HOME）。直接 mkdir/写文件会在 CWD 下
# 创建字面 $HOME 目录。此函数把 $HOME / $USERPROFILE 展开为真实值，
# 与 orchestrator.js 的 `.replace(/\$HOME/g, homedir())` 对齐。
# 用法：VAR="$(_expand_home "$RAW_VAR")"
# Issue !274: 原实现用 sed 替换，Windows 的 USERPROFILE 形如 C:\Users\11341，
# 替换值中的 \1 被 sed 解析为不存在的分组引用（invalid reference \1）→ 非零退出，
# set -e 的调用方（memory-route-guard 等）启动即死。改为纯 bash 参数展开，
# 值不经过任何再解释，反斜杠/数字用户名安全（bash 3.2 兼容）。
_expand_home() {
    local _s="$1"
    _s="${_s//\$HOME/${HOME}}"
    _s="${_s//\$USERPROFILE/${USERPROFILE:-${HOME}}}"
    printf '%s' "$_s"
}
