#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR"/../../../.. && pwd)"
INSTALL="$PROJECT_ROOT/install.sh"
SETUP="$PROJECT_ROOT/.claude/tools/scripts/setup/setup-harness.sh"
HOOK_SETUP="$PROJECT_ROOT/.claude/tools/scripts/setup/setup-hooks.sh"
HARNESS="$PROJECT_ROOT/harness"

grep -q 'codebuddy | codex | qoder | zcode | claude | all' "$INSTALL"
grep -q 'claude codebuddy codex qoder zcode' "$INSTALL"
grep -q 'local choices=(claude codex codebuddy qoder zcode all)' "$INSTALL"
grep -q 'all).*GEN_TARGETS="codebuddy codex qoder zcode"' "$INSTALL"
grep -q 'zcode).*GEN_TARGETS="zcode"' "$INSTALL"
grep -q 'for _bd in .codex .codebuddy .qoder .zcode' "$INSTALL"
grep -q 'configure-zcode-plugin.mjs' "$INSTALL"
grep -q 'uni-auri@inline' "$INSTALL"
grep -q '源仓库不作为业务项目注册 ZCode 插件' "$INSTALL"
grep -q 'ZCode: Skills、Agents 与 Hooks 已自动注册，后续新会话自动加载' "$INSTALL"
! grep -q '添加插件市场' "$INSTALL"

grep -q 'zcode).*rd_tools="claude"' "$SETUP"
grep -q 'for _bd in .codex .codebuddy .qoder .zcode' "$SETUP"
grep -q '.codex>.codebuddy>.qoder>.zcode>.claude' "$HOOK_SETUP"
grep -q '.claude .codex .codebuddy .qoder .zcode' "$HARNESS"

echo 'test_zcode_install_support: all tests passed'
