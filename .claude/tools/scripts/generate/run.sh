#!/usr/bin/env bash
# run.sh — Uni-AURI 多 agent 配置生成器入口。
# 用法：
#   bash run.sh                 # 生成全部 agent
#   bash run.sh codebuddy       # 仅 codebuddy
#   bash run.sh codex           # 仅 codex
set -euo pipefail
cd "$(dirname "$0")"
exec node generate.mjs "$@"
