#!/usr/bin/env bash
# PreToolUse hook: 组合 Git 操作守卫
# - 禁止读写框架保护文件
# - 禁止 git pull 拉取基线分支 main/master
# - 禁止本地 git merge 合并不同分支
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/hook-json-helper.sh"

# issue !308：带超时读 stdin；超时/读失败 fail-open（放行好过阻塞工具调用 60s）
INPUT=$(hook_read_stdin) || {
    echo "[git-guard] stdin 读取超时/失败，fail-open 放行（issue !308）" >&2
    exit 0
}
TOOL=$(_jq_val "$INPUT" tool_name)

case "$TOOL" in
    Bash) ;;
    *) exit 0 ;;
esac

COMMAND=$(_jq_val "$INPUT" command)

# ── 1) 框架保护路径 / bypass 文件 ──
# 保护策略：Edit/Write 工具侧已有 guard，Bash 侧只拦破坏性操作。
# git add/status/diff 等无害操作不受影响。
# 框架目录默认即本 agent 目录；generator 注入 HARNESS_ROOT 让非 Claude 环境复用同一目录。
# 单引号 ERE 里无法内插 $HARNESS_ROOT（会被当成行尾锚），故运行时先转义再拼正则。
_HARNESS_DIR="${HARNESS_ROOT:-.claude}"
_HARNESS_DIR_RE="$(printf '%s' "$_HARNESS_DIR" | sed -e 's/[][\.*^$/]/\\&/g')"
_PROTECTED_RE="(\\.git[/\\\\]hooks[/\\\\]|${_HARNESS_DIR_RE}[/\\\\]hooks[/\\\\])"
# .branch-challenge 受保护（AI 不可读，NONCE 只能从 hook 输出获取）；
# .branch-approved 与 .push-approved 一样保持 AI 可写（写入 PM 批准的 token）。
_BYPASS_FILES_RE="(\\.harness[/\\\\]\\.(framework-edit|push-challenge|branch-challenge)|\\.(framework-edit|push-challenge|branch-challenge))"
_SAFE_GIT_RE='^git[[:space:]]+(add|status|diff|log|stash)[[:space:]]'

if echo "$COMMAND" | grep -qE "$_SAFE_GIT_RE"; then
    : # git add/status/diff 不拦截
elif echo "$COMMAND" | grep -qE "$_PROTECTED_RE"; then
    hook_deny "框架保护区，AI 止步。这些文件只有人类的肉身之手才能碰——去请 PM 帮你吧。"
    exit 0
elif echo "$COMMAND" | grep -qE "$_BYPASS_FILES_RE"; then
    hook_deny "框架保护区，AI 止步。这些文件只有人类的肉身之手才能碰——去请 PM 帮你吧。"
    exit 0
fi

# ── 2) 禁止 git pull 拉取 main/master（无 --rebase）──
# 含 --rebase 时放行（如 git pull --rebase origin main，是合法的基线同步），
# 因为 --rebase 不会产生 merge commit。--no-rebase 不含子串 --rebase，仍被拦。
if echo "$COMMAND" | grep -qE '(^|[;&|][[:space:]]*)git[[:space:]]+pull[[:space:]]+.*\b(main|master)\b' \
   && ! echo "$COMMAND" | grep -qE -- '--rebase'; then
    hook_deny "禁止通过 git pull 拉取基线分支 main/master。基线同步必须通过 GitLab Merge Request 流程，确保代码评审和 CI 门禁。"
    exit 0
fi

# ── 2.5) 禁止裸 git pull（无 --rebase）──
# 裸 git pull 默认走 merge 策略，落后远端时产生 merge commit，
# 被服务端 pre-receive 拒（事后拦截，AI 已 push 失败需返工）。
# 同步远端统一用 git pull --rebase。--no-rebase 不含子串 --rebase，仍被拦。
if echo "$COMMAND" | grep -qE '(^|[;&|][[:space:]]*)git[[:space:]]+pull([[:space:]]|$)' \
   && ! echo "$COMMAND" | grep -qE -- '--rebase'; then
    hook_deny "禁止裸 git pull（默认 merge 策略会产生 merge commit 被服务端 pre-receive 拒绝）。同步远端请用 git pull --rebase。"
    exit 0
fi

# ── 3) 禁止本地 git merge 合并分支 ──
if echo "$COMMAND" | grep -qE '(^|[;&|][[:space:]]*)git[[:space:]]+merge([[:space:]]|$)'; then
    hook_deny "禁止本地 git merge 合并不同分支。分支合并必须通过 GitLab Merge Request 流程，确保代码评审和 CI 门禁。"
    exit 0
fi

# ── 4) 分支创建治理：名校验 + PM 审批（Challenge-Response）──
# AI 创建分支（checkout -b/-B、switch -c/-C、branch <name>、worktree add -b）
# 须先过分支名校验（ai-git-commit-spec.md「分支命名规范」），合规后仍需
# PM challenge-response 审批。机制复用 push 审批（.claude/hooks/git/pre-push），
# 差异：绑定目标分支名（建分支时 HEAD 不变），而非 HEAD hash。
# 仅拦「新建」；切换/检出已有分支、列分支、删分支不拦。
# CI 环境通过 CLAUDE_BRANCH_AUTO_APPROVE=1 自动放行。
if [ "${CLAUDE_BRANCH_AUTO_APPROVE:-}" != "1" ]; then
    _BRANCH_NAME=""
    # 4.1 提取目标分支名
    if printf '%s' "$COMMAND" | grep -qE '(^|[[:space:]])git[[:space:]]+(checkout|switch)([[:space:]]|$)' \
       && printf '%s' "$COMMAND" | grep -qE '[[:space:]]-[bBCc]([[:space:]]|$)'; then
        # checkout -b/-B <name> / switch -c/-C <name>
        _BRANCH_NAME=$(printf '%s' "$COMMAND" | sed -nE 's/.*[[:space:]]-[bBCc][[:space:]]+([^[:space:]]+).*/\1/p' | head -1 || true)
    elif printf '%s' "$COMMAND" | grep -qE '(^|[[:space:]])git[[:space:]]+worktree[[:space:]]+add([[:space:]]|$)' \
       && printf '%s' "$COMMAND" | grep -qE '[[:space:]]-[bB]([[:space:]]|$)'; then
        # git worktree add -b <name> <path>
        _BRANCH_NAME=$(printf '%s' "$COMMAND" | sed -nE 's/.*[[:space:]]-[bB][[:space:]]+([^[:space:]]+).*/\1/p' | head -1 || true)
    elif printf '%s' "$COMMAND" | grep -qE '(^|[[:space:]])git[[:space:]]+branch([[:space:]]|$)'; then
        # git branch <name> [start-point]：branch 后第一个 token 不以 - 开头才是创建，
        # 跟 flag（-d/-D/-m/-M/-r/-a/-v/--list 等）的是删除/列举/重命名，放行
        _BRANCH_NAME=$(printf '%s' "$COMMAND" | sed -nE 's/.*[[:space:]]branch[[:space:]]+([^[:space:]]+).*/\1/p' | head -1 || true)
        case "$_BRANCH_NAME" in
            -*) _BRANCH_NAME="" ;;
        esac
    fi
    # 去首尾引号
    _BRANCH_NAME="${_BRANCH_NAME#\"}"; _BRANCH_NAME="${_BRANCH_NAME%\"}"
    _BRANCH_NAME="${_BRANCH_NAME#\'}"; _BRANCH_NAME="${_BRANCH_NAME%\'}"

    if [ -n "$_BRANCH_NAME" ]; then
        # 4.2 分支名合规校验（type 白名单 + 全小写 kebab-case，允许多级子路径）
        _BRANCH_VALID_RE='^(feature|fix|hotfix|refactor|docs|chore)/[a-z0-9]+([.-][a-z0-9]+)*(/[a-z0-9]+([.-][a-z0-9]+)*)*$'
        if ! printf '%s' "$_BRANCH_NAME" | grep -qE "$_BRANCH_VALID_RE"; then
            hook_deny "禁止创建不符合命名规范的分支「${_BRANCH_NAME}」。
合法格式：<type>/<task-id>[-<短描述>]，type ∈ feature/fix/hotfix/refactor/docs/chore，全小写 kebab-case。
示例：feature/630、fix/152-render-bug、hotfix/payment-down。
特殊分支（release/* 等）请 PM 在终端自行创建。"
            exit 0
        fi

        # 4.3 PM 审批 Challenge-Response（状态机对齐 pre-push，绑定分支名）
        # 挑战码文件格式：NONCE:BRANCH_NAME:TIMESTAMP；TTL 300s，single-use。
        _BC_DIR="${CLAUDE_PROJECT_DIR:-.}"
        _BC_CHALLENGE="${_BC_DIR}/.harness/.branch-challenge"
        _BC_TOKEN="${_BC_DIR}/.harness/.branch-approved"
        _BC_TTL=300

        _bc_mtime() {
            stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null || echo 0
        }
        _bc_expired() {
            local _age=$(( $(date +%s) - $(_bc_mtime "$1") ))
            [ "$_age" -gt "$_BC_TTL" ]
        }

        if [ -f "$_BC_CHALLENGE" ] && [ -f "$_BC_TOKEN" ]; then
            _C_CONTENT=$(cat "$_BC_CHALLENGE" 2>/dev/null || true)
            _T_CONTENT=$(cat "$_BC_TOKEN" 2>/dev/null || true)
            _C_NONCE=$(printf '%s' "$_C_CONTENT" | cut -d: -f1)
            _C_BRANCH=$(printf '%s' "$_C_CONTENT" | cut -d: -f2)
            if _bc_expired "$_BC_CHALLENGE"; then
                rm -f "$_BC_CHALLENGE" "$_BC_TOKEN"
                hook_deny "分支创建审批挑战码已过期（>5分钟），已清除。请重新执行建分支命令触发新挑战码。"
                exit 0
            fi
            if [ "$_T_CONTENT" = "$_C_NONCE" ] && [ "$_C_BRANCH" = "$_BRANCH_NAME" ]; then
                # 审批通过：清理状态文件，放行
                rm -f "$_BC_CHALLENGE" "$_BC_TOKEN"
                exit 0
            fi
            rm -f "$_BC_TOKEN"
            hook_deny "分支创建令牌无效（不匹配或分支名不一致），已删除令牌。
挑战码绑定分支：${_C_BRANCH:-（无）}，本次请求：${_BRANCH_NAME}。
请重新执行建分支命令触发新挑战码。"
            exit 0
        fi

        if [ -f "$_BC_TOKEN" ] && [ ! -f "$_BC_CHALLENGE" ]; then
            rm -f "$_BC_TOKEN"
            hook_deny "分支创建挑战码已失效（无对应挑战码文件），已清除令牌。请重新执行建分支命令触发新挑战码。"
            exit 0
        fi

        if [ -f "$_BC_CHALLENGE" ] && ! _bc_expired "$_BC_CHALLENGE"; then
            _C_CONTENT=$(cat "$_BC_CHALLENGE" 2>/dev/null || true)
            _C_NONCE=$(printf '%s' "$_C_CONTENT" | cut -d: -f1)
            _C_BRANCH=$(printf '%s' "$_C_CONTENT" | cut -d: -f2)
            if [ "$_C_BRANCH" = "$_BRANCH_NAME" ]; then
                hook_deny "分支创建需要 PM 审批（挑战码已生成，等待批准）。
分支名：${_BRANCH_NAME}  挑战码：${_C_NONCE}
PM 审批方式：回复 AI「批准 ${_C_NONCE}」，AI 写入 token 后重新执行建分支命令。
⚠️ 建分支完成前不得创建新挑战码以外不要执行其他建分支操作。"
                exit 0
            fi
            # 请求的分支名与挑战码不一致 → 旧挑战码作废，fall through 生成新码
            rm -f "$_BC_CHALLENGE"
        fi

        # 生成新挑战码（od 4 字节随机 → 8 位 hex，对齐 pre-push）
        mkdir -p "${_BC_DIR}/.harness" 2>/dev/null || true
        rm -f "$_BC_CHALLENGE" 2>/dev/null || true
        _BC_NONCE=$(od -An -tx1 -N4 /dev/urandom | tr -d ' \n' || true)
        printf '%s:%s:%s\n' "$_BC_NONCE" "$_BRANCH_NAME" "$(date +%s)" > "$_BC_CHALLENGE" 2>/dev/null || true
        hook_deny "分支创建需要 PM 审批（首次触发）。
分支名：${_BRANCH_NAME}  挑战码：${_BC_NONCE}
PM 审批方式：回复 AI「批准 ${_BC_NONCE}」，AI 写入 token 后重新执行建分支命令。
（AI 写入方式：echo ${_BC_NONCE} > .harness/.branch-approved）"
        exit 0
    fi
fi

# ── 5) push 审批兜底：会话级 Challenge-Response ──
# 仓级 pre-push hook 是 push 审批的主门禁，但它只对【已安装 hooks 的仓】生效：
# 新 clone 未跑 setup、或 AI 在任意外部仓 push 时，审批形同不存在（issue !294 / !297）。
# 双层设计（避免双重审批）：
#   目标仓已装可执行 pre-push → 由其接管，本 guard 放行；
#   未装 → 本 guard 兜底同等强度的会话级挑战码审批，状态机与 4.3 分支审批同构。
# CI 环境通过 CLAUDE_PUSH_AUTO_APPROVE=1 自动放行（与 pre-push 同名开关）。
if [ "${CLAUDE_PUSH_AUTO_APPROVE:-}" != "1" ]; then
    # 匹配 git push；允许 -C <dir> / -c <k=v> 前置参数（-c 可改 core.hooksPath 绕过
    # 仓级 hook，漏判即门禁失效）。前缀须位于命令起始或 ; & | ( 分隔符之后，
    # 避免命中引号内的「git push」文本。
    _PUSH_RE='(^|[;&|(][[:space:]]*)git([[:space:]]+-[cC][[:space:]]+[^;&|]+)*[[:space:]]+push([[:space:]]|$)'
    if printf '%s' "$COMMAND" | grep -qE "$_PUSH_RE"; then
        # 5.1 目标仓解析：git -C <dir> push → dir；cd <dir> (&&|;) git push → dir；
        # 都没有则回落会话根 CLAUDE_PROJECT_DIR（AI 通常在会话根执行 push）。
        # 解析结果不是目录时同样回落会话根（fail-safe，不因路径解析偏差误判）。
        _PG_DIR=""
        # 前置补一个空格：命令可能以 git/cd 开头，sed 里用 [[:space:]] 定界才能命中
        if printf ' %s' "$COMMAND" | grep -qE '[[:space:]]git[[:space:]]+-C[[:space:]]+'; then
            _PG_DIR=$(printf ' %s' "$COMMAND" | sed -nE 's/.*[[:space:]]git[[:space:]]+-C[[:space:]]+([^[:space:];&|]+).*/\1/p' | head -1)
        fi
        if [ -z "$_PG_DIR" ]; then
            _PG_DIR=$(printf ' %s' "$COMMAND" | sed -nE 's/.*[[:space:]]cd[[:space:]]+([^[:space:];&|]+).*/\1/p' | head -1)
        fi
        # 去首尾引号（cd "dir" && git push）
        _PG_DIR="${_PG_DIR#\"}"; _PG_DIR="${_PG_DIR%\"}"
        _PG_DIR="${_PG_DIR#\'}"; _PG_DIR="${_PG_DIR%\'}"
        if [ -z "$_PG_DIR" ] || [ ! -d "$_PG_DIR" ]; then
            _PG_DIR="${CLAUDE_PROJECT_DIR:-.}"
        fi

        # 5.2 双重审批判定：目标仓已装可执行 pre-push → 仓级门禁接管，本兜底不介入
        # （否则被管理仓会同时要求仓级挑战码与会话级挑战码）。
        _PG_HOOKS=$(git -C "$_PG_DIR" rev-parse --git-path hooks 2>/dev/null || true)
        case "$_PG_HOOKS" in
            /*) ;;                                    # 绝对路径（worktree/子模块常见）
            "") ;;                                    # 非 git 仓 → 无仓级 hook
            *) _PG_HOOKS="${_PG_DIR}/${_PG_HOOKS}" ;; # 相对路径：-C 后 cwd 即目标仓
        esac
        if [ -n "$_PG_HOOKS" ] && [ -x "${_PG_HOOKS}/pre-push" ]; then
            exit 0
        fi

        # 5.3 未装 hook → 会话级挑战码审批
        # 状态文件写在【目标仓】.harness/，文件名与内容格式（NONCE:HEAD:TIMESTAMP）
        # 与仓级 pre-push 一致，故 PM 的审批指令「回复 AI 批准 <nonce>」两层通用；
        # 挑战码绑定目标仓 HEAD，推送内容变化即失效。
        _PG_CHALLENGE="${_PG_DIR}/.harness/.push-challenge"
        _PG_TOKEN="${_PG_DIR}/.harness/.push-approved"
        # 挑战码有效期（秒）；single_use，审批通过即清理。
        # 改此值须同步：权威源 harness-rules.yaml push_approval.security.ttl_seconds
        # + pre-push 的 PUSH_TTL_SECONDS + 下方过期提示文案的分钟数。
        _PG_TTL=300
        _PG_HASH=$(git -C "$_PG_DIR" rev-parse --short HEAD 2>/dev/null || echo "unknown")
        _PG_SUBJECT=$(git -C "$_PG_DIR" log -1 --format="%s" 2>/dev/null || echo "unknown")

        _pg_mtime() {
            stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null || echo 0
        }
        _pg_expired() {
            local _age=$(( $(date +%s) - $(_pg_mtime "$1") ))
            [ "$_age" -gt "$_PG_TTL" ]
        }
        # 输出审批提示并拦截（$1=提示语 $2=挑战码）
        _pg_deny() {
            hook_deny "$1
目标仓：${_PG_DIR}
待推提交：${_PG_SUBJECT}
HEAD: ${_PG_HASH}  挑战码：$2
PM 审批方式（二选一）：
1. 手动: echo $2 > ${_PG_DIR}/.harness/.push-approved 后重新 git push
2. 自动: 回复 AI「批准推送」，AI 写入 token 后重推
⚠️ push 完成前不得创建新 commit（否则挑战码失效）。
（目标仓安装 pre-push hook 后，push 审批由仓级门禁接管，本兜底不再介入）"
        }

        if [ -f "$_PG_CHALLENGE" ] && [ -f "$_PG_TOKEN" ]; then
            _PG_C_CONTENT=$(cat "$_PG_CHALLENGE" 2>/dev/null || true)
            _PG_T_CONTENT=$(cat "$_PG_TOKEN" 2>/dev/null || true)
            _PG_C_NONCE=$(printf '%s' "$_PG_C_CONTENT" | cut -d: -f1)
            _PG_C_HASH=$(printf '%s' "$_PG_C_CONTENT" | cut -d: -f2)
            if _pg_expired "$_PG_CHALLENGE"; then
                rm -f "$_PG_CHALLENGE" "$_PG_TOKEN"
                hook_deny "push 审批挑战码已过期（>5分钟），已清除。请重新执行 git push 触发新挑战码，PM 批准后再推。"
                exit 0
            fi
            if [ "$_PG_T_CONTENT" = "$_PG_C_NONCE" ] && [ "$_PG_C_HASH" = "$_PG_HASH" ]; then
                # 审批通过：清理状态文件，放行
                rm -f "$_PG_CHALLENGE" "$_PG_TOKEN"
                exit 0
            fi
            # 令牌不匹配，或 HEAD 已变更（挑战码绑定失效）→ 删令牌重来
            rm -f "$_PG_TOKEN"
            _pg_deny "push 令牌无效（与挑战码不匹配，或 HEAD 已变更导致挑战码失效），已删除令牌。" "$_PG_C_NONCE"
            exit 0
        fi

        if [ -f "$_PG_TOKEN" ] && [ ! -f "$_PG_CHALLENGE" ]; then
            rm -f "$_PG_TOKEN"
            hook_deny "push 挑战码已失效（无对应挑战码文件），已清除令牌。请重新执行 git push 触发新挑战码。"
            exit 0
        fi

        if [ -f "$_PG_CHALLENGE" ] && ! _pg_expired "$_PG_CHALLENGE"; then
            _PG_C_CONTENT=$(cat "$_PG_CHALLENGE" 2>/dev/null || true)
            _PG_C_NONCE=$(printf '%s' "$_PG_C_CONTENT" | cut -d: -f1)
            _PG_C_HASH=$(printf '%s' "$_PG_C_CONTENT" | cut -d: -f2)
            if [ "$_PG_C_HASH" = "$_PG_HASH" ]; then
                _pg_deny "push 需要 PM 审批（挑战码已生成，等待批准）。" "$_PG_C_NONCE"
                exit 0
            fi
            # HEAD 已变更 → 旧挑战码作废，fall through 生成新码
            rm -f "$_PG_CHALLENGE"
        fi

        # 生成新挑战码（od 4 字节随机 → 8 位 hex，对齐 pre-push）
        mkdir -p "${_PG_DIR}/.harness" 2>/dev/null || true
        if [ ! -d "${_PG_DIR}/.harness" ]; then
            # fail-open：状态目录不可创建（只读挂载等）时不阻塞 push，仅 stderr 告警
            echo "[git-guard] 无法创建 ${_PG_DIR}/.harness，会话级 push 审批不可用，fail-open 放行" >&2
            exit 0
        fi
        rm -f "$_PG_CHALLENGE" 2>/dev/null || true
        _PG_NONCE=$(od -An -tx1 -N4 /dev/urandom | tr -d ' \n' || true)
        printf '%s:%s:%s\n' "$_PG_NONCE" "$_PG_HASH" "$(date +%s)" > "$_PG_CHALLENGE" 2>/dev/null || true
        _pg_deny "push 需要 PM 审批（目标仓未安装 pre-push hook，由会话级门禁兜底）。" "$_PG_NONCE"
        exit 0
    fi
fi

exit 0
