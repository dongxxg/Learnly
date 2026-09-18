#!/usr/bin/env bash
# Tests for check_hookspath_health: 检测 core.hooksPath 是否指向不存在目录
# Context: 仓库迁移或误配置会让 hooksPath 指向不存在路径，git 静默跳过所有
# hook（pre-push 挑战码 / pre-commit / commit-msg 全失效）。本函数提供检测 + 自愈。
#
# 注意: 函数定义从 setup-harness.sh:check_hookspath_health inline（保持同步），
# 避免修改框架入口添加 main guard。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# 不导入完整 setup-harness.sh（会触发 main dispatch），inline 待测函数 + 依赖
SETUP_HARNESS="${SCRIPT_DIR}/../setup/setup-harness.sh"

# 颜色定义（与 setup-harness.sh L70 一致）
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
DIM='\033[2m'
NC='\033[0m'

info()  { printf "${GREEN}[setup-hooks]${NC} %s\n" "$1"; }
warn()  { printf "${YELLOW}[setup-hooks]${NC} %s\n" "$1"; }
error() { printf "${RED}[setup-hooks]${NC} %s\n" "$1" >&2; }

# ── inline: check_hookspath_health ──
# 同步自 setup-harness.sh:check_hookspath_health
check_hookspath_health() {
  local target="$1"
  local fix="${2:-}"

  [ "$fix" = "--fix" ] || fix=""

  local configured
  configured="$(git -C "$target" config --get core.hooksPath 2>/dev/null || true)"
  [ -z "$configured" ] && return 0

  local abs_path="$configured"
  case "$abs_path" in
    /*) ;;
    *)  abs_path="$target/$abs_path" ;;
  esac

  [ -d "$abs_path" ] && return 0

  if [ -n "$fix" ]; then
    git -C "$target" config --unset core.hooksPath
    info "已清理无效的 core.hooksPath=$configured ✓"
    warn "原配置指向不存在的目录，已 unset，git 将回退到默认 .git/hooks/"
    return 0
  fi
  return 1
}

# ── 测试基础设施 ──
PASS=0
FAIL=0
CLEANUP_DIRS=""

cleanup() {
  for d in ${CLEANUP_DIRS}; do
    rm -rf "${d}"
  done
}
trap cleanup EXIT

pass() { echo "PASS"; PASS=$((PASS + 1)); }
fail() { echo "FAIL — $1"; FAIL=$((FAIL + 1)); }

# 用 git -c core.hooksPath=/dev/null 隔离测试本身（防止触发框架 hook）
GIT_CMD="git -c core.hooksPath=/dev/null"

create_git_repo() {
  local dir
  dir="$(mktemp -d)"
  CLEANUP_DIRS="${CLEANUP_DIRS} ${dir}"
  (
    cd "${dir}"
    ${GIT_CMD} init --quiet
    ${GIT_CMD} config user.name "test"
    ${GIT_CMD} config user.email "test@test.com"
  )
  echo "${dir}"
}

echo "check_hookspath_health Tests"
echo "============================="

# Test 1: 未配置 hooksPath → 健康（return 0）
echo -n "  未配置 → 健康 (return 0): "
D1=$(create_git_repo)
if check_hookspath_health "$D1"; then pass; else fail "expected 0, got $?"; fi

# Test 2: 配置正确 hooksPath（指向存在目录）→ 健康（return 0）
echo -n "  配置正确目录 → 健康 (return 0): "
D2=$(create_git_repo)
mkdir -p "$D2/.git/hooks"
${GIT_CMD} -C "$D2" config core.hooksPath .git/hooks
if check_hookspath_health "$D2"; then pass; else fail "expected 0, got $?"; fi

# Test 3: 配置不存在 hooksPath（无 --fix）→ 不健康（return 1），配置保留
echo -n "  配置不存在目录（无 --fix）→ return 1 + 配置保留: "
D3=$(create_git_repo)
${GIT_CMD} -C "$D3" config core.hooksPath /nonexistent/path-xyz
if ! check_hookspath_health "$D3"; then
  CFG="$(git -C "$D3" config --get core.hooksPath)"
  [ "$CFG" = "/nonexistent/path-xyz" ] && pass || fail "config should be preserved, got: $CFG"
else
  fail "expected non-zero exit, got 0"
fi

# Test 4: 配置不存在 hooksPath + --fix → 自愈（return 0），配置已 unset
echo -n "  配置不存在目录 + --fix → 自愈 + 配置 unset: "
D4=$(create_git_repo)
${GIT_CMD} -C "$D4" config core.hooksPath /nonexistent/path-abc
if check_hookspath_health "$D4" "--fix" >/dev/null 2>&1; then
  CFG="$(git -C "$D4" config --get core.hooksPath 2>/dev/null || true)"
  [ -z "$CFG" ] && pass || fail "config should be unset, got: $CFG"
else
  fail "expected 0 after fix, got $?"
fi

# Test 5: 相对路径配置，目录存在 → 健康
echo -n "  相对路径配置（目录存在）→ 健康: "
D5=$(create_git_repo)
mkdir -p "$D5/custom-hooks"
${GIT_CMD} -C "$D5" config core.hooksPath custom-hooks
if check_hookspath_health "$D5"; then pass; else fail "expected 0, got $?"; fi

# Test 6: --fix 之外的参数不应触发修复（仅识别 --fix）
echo -n "  非 --fix 参数不触发修复（仍 return 1）: "
D6=$(create_git_repo)
${GIT_CMD} -C "$D6" config core.hooksPath /nonexistent/other
if ! check_hookspath_health "$D6" "--diagnose" 2>/dev/null; then
  CFG="$(git -C "$D6" config --get core.hooksPath)"
  [ "$CFG" = "/nonexistent/other" ] && pass || fail "config unexpectedly modified: $CFG"
else
  fail "expected non-zero, got 0"
fi

echo "============================="
echo "Results: ${PASS} passed, ${FAIL} failed"
[ "${FAIL}" -gt 0 ] && exit 1
exit 0
