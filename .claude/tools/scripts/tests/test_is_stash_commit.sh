#!/usr/bin/env bash
# Tests for collect-git.js isStashCommit (Issue !157 stash 子问题)
#
# 背景：git stash 创建的内部 commit subject 有两种格式：
#   1. 默认格式（git stash create）：
#      - "WIP on <branch>"
#      - "index on <branch>"
#      - "untracked files on <branch>"
#   2. 自定义消息格式（git stash push -m "msg" / git stash save "msg"）：
#      - "On <branch>: <msg>"
#
# 原实现只覆盖格式 1，sunli 报的 "On branch-name: stash message" 被误识别为
# 人工 commit，污染日报。
#
# 本测试覆盖以下场景（10 个）：
#   默认格式（3）：
#     1) PASS: "WIP on main" → true
#     2) PASS: "index on feature/630" → true（含斜杠的 branch）
#     3) PASS: "untracked files on dev" → true
#   自定义消息格式（2）：
#     4) PASS: "On main: my stash message" → true（新增覆盖）
#     5) PASS: "On feature/630: wip login" → true（含斜杠）
#   误报防护（5）：
#     6) PASS: "On dev: " 后接空消息 → false（git 不会产空 msg，保守）
#     7) PASS: "On main" 无冒号 → false
#     8) PASS: "On main:no-space" → false（git 规范要求冒号后空格）
#     9) PASS: "[0] BUG foo[AI-wangzk.Developer]" → false（人工 commit）
#    10) PASS: "fix: On branch foo: bar" → false（前缀不对，非 subject）
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
COLLECT_GIT="${SCRIPT_DIR}/../../../skills/daily-report/scripts/collect-git.js"

PASS=0
FAIL=0

if [ ! -f "${COLLECT_GIT}" ]; then
    echo "SKIP: collect-git.js not found at ${COLLECT_GIT}"
    exit 1
fi

# check_stash <subject> <expected>
# require collect-git.js 会触发 main() 跑 git 并打印 JSON。为隔离测试：
#   1) stub execFileSync（让 main() 不做真实 git 调用）
#   2) 屏蔽 process.stdout.write（吞掉 main 的 JSON 输出）
#   3) 用 process.stderr 输出 isStashCommit 结果，shell 端从 stderr 捕获
check_stash() {
    local subject="$1"
    local expected="$2"
    local actual
    actual=$(node -e "
const cp = require('node:child_process');
cp.execFileSync = (cmd, args) => {
  if (args && args.includes('config') && args.includes('user.name')) return 'tester';
  return '';
};
process.stdout.write = () => true;   // 吞掉 main() 的 JSON 输出
const m = require('${COLLECT_GIT}');
process.stderr.write(m.isStashCommit(process.argv[1]) ? 'true' : 'false');
" "${subject}" 2>&1 >/dev/null)
    if [ "${expected}" = "${actual}" ]; then
        echo "PASS: subject=\"${subject}\" → ${actual}"
        PASS=$((PASS + 1))
    else
        echo "FAIL: subject=\"${subject}\" expected=${expected} actual=${actual}"
        FAIL=$((FAIL + 1))
    fi
}

# --- 默认格式（git stash create） ---

check_stash "WIP on main" "true"
check_stash "index on feature/630" "true"
check_stash "untracked files on dev" "true"

# --- 自定义消息格式（git stash push -m "msg" / git stash save "msg"） ---

check_stash "On main: my stash message" "true"
check_stash "On feature/630: wip login" "true"

# --- 误报防护 ---

# git 实际不会产空 msg（push -m "" 时 git 会拒绝），保守按 false
check_stash "On dev: " "false"
# 无冒号（branch 后必须有 ": "）
check_stash "On main" "false"
# 冒号后无空格（git 规范要求 ": "，单冒号不匹配）
check_stash "On main:no-space" "false"
# 人工 commit
check_stash "[0] BUG foo[AI-wangzk.Developer]" "false"
# 前缀不对（不是 subject 起始）
check_stash "fix: On branch foo: bar" "false"

echo "-----------------------------------------"
echo "isStashCommit: ${PASS} passed, ${FAIL} failed"

if [ "${FAIL}" -gt 0 ]; then
    exit 1
fi
