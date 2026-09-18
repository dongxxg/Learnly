#!/usr/bin/env bash
# setup-hooks.sh — AI Git 提交规范 Hook 部署脚本（纯 bash，零依赖）
# 规范文档: .claude/rules/ai-git-commit-spec.md
#
# 用法:
#   bash .claude/tools/scripts/setup/setup-hooks.sh          # 安装
#   bash .claude/tools/scripts/setup/setup-hooks.sh --remove # 移除
#   bash .claude/tools/scripts/setup/setup-hooks.sh --check  # 检查状态

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"

# HOOKS_SRC 跟随 backend 目录（issue: hook-backend-dir-fix C8）。
# install_git_hooks 调本脚本时继承 HARNESS_BACKEND 环境变量（用户 export），
# standalone 调用（用户手动运行）时 fallback 读已写的 git config，
# 源仓默认 .claude。与 hook 探测头（pre-commit/pre-push 读 harness.backend-dir）
# 及 trampoline 运行时探测（.codex>.codebuddy>.qoder>.zcode>.claude）语义一致。
if [ -n "${HARNESS_BACKEND:-}" ]; then
  _BACKEND_DIR=".${HARNESS_BACKEND}"
else
  _BACKEND_DIR="$(git -C "$PROJECT_ROOT" config --get harness.backend-dir 2>/dev/null | head -1 || true)"
fi
HOOKS_SRC="$PROJECT_ROOT/${_BACKEND_DIR:-.claude}/hooks/git"
# Issue !280: linked worktree 的 .git 是文件不是目录，hooks 实际位于主仓库
# .git/hooks（共享），写死 "$PROJECT_ROOT/.git/hooks" 会在 worktree 内安装时
# 直接报"目录不存在"退出 1 并留下部分升级状态。以 git rev-parse --git-path
# hooks 的权威结果定位（同时兼容 core.hooksPath 被设置的情况）。
_GIT_HOOKS_RAW="$(git -C "$PROJECT_ROOT" rev-parse --git-path hooks 2>/dev/null || true)"
if [ -n "${_GIT_HOOKS_RAW}" ]; then
  case "${_GIT_HOOKS_RAW}" in
    /*|[A-Za-z]:[\\/]*) GIT_HOOKS_DIR="${_GIT_HOOKS_RAW}" ;;
    *) GIT_HOOKS_DIR="$PROJECT_ROOT/${_GIT_HOOKS_RAW}" ;;
  esac
else
  # 非 git 环境兜底：保持原路径，让下游目录检查给出既有报错
  GIT_HOOKS_DIR="$PROJECT_ROOT/.git/hooks"
fi

TRAMPOLINE_MARKER="Auto-generated hook trampoline"

GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
NC='\033[0m'

info()  { printf "${GREEN}[setup-hooks]${NC} %s\n" "$1"; }
warn()  { printf "${YELLOW}[setup-hooks]${NC} %s\n" "$1"; }
error() { printf "${RED}[setup-hooks]${NC} %s\n" "$1" >&2; }

# ============================================================
# 安装单个 hook
# ============================================================
install_single_hook() {
  local hook_name="$1"
  local hook_src="$HOOKS_SRC/$hook_name"
  local target="$GIT_HOOKS_DIR/$hook_name"

  if [ ! -f "$hook_src" ]; then
    warn "hook 脚本不存在，跳过: $hook_src"
    return
  fi

  # 已是 trampoline 则跳过
  if [ -f "$target" ] && grep -q "$TRAMPOLINE_MARKER" "$target" 2>/dev/null; then
    info "$hook_name hook 已是 trampoline，跳过"
    return
  fi

  # 备份已有 hook（符号链接或非 trampoline 文件）
  if [ -f "$target" ] || [ -L "$target" ]; then
    local backup="${target}.bak.$(date +%Y%m%d%H%M%S)"
    cp "$target" "$backup" 2>/dev/null || true
    warn "已备份现有 $hook_name → $(basename "$backup")"
  fi

  rm -f "$target"

  # trampoline: 先读取安装时写入的 harness.backend-dir 精确选择 backend；
  # 配置缺失/非法时再按固定顺序兜底探测。
  # Issue !280: linked worktree 下 hooks 位于主仓库 .git/hooks，../.. 相对路径会
  # 错误定位到主仓库根而非当前提交所在的 worktree。git 执行 hook 时 cwd 即 worktree
  # 根，优先用 rev-parse --show-toplevel 取真实根，取不到再退 ../..。
  cat > "$target" <<TRAMPOLINE
#!/usr/bin/env bash
# $TRAMPOLINE_MARKER — probes backend dirs (.codex > .codebuddy > .qoder > .zcode > .claude) for ${hook_name}
HOOK_DIR="\$(cd "\$(dirname "\$0")" && pwd)"
PROJECT_ROOT="\$(git rev-parse --show-toplevel 2>/dev/null || true)"
[ -n "\$PROJECT_ROOT" ] || PROJECT_ROOT="\$(cd "\$HOOK_DIR/../.." && pwd)"
_configured_bd="\$(git -C "\$PROJECT_ROOT" config --get harness.backend-dir 2>/dev/null | head -1 || true)"
case "\$_configured_bd" in
  .claude|.codex|.codebuddy|.qoder|.zcode)
    if [ -f "\$PROJECT_ROOT/\$_configured_bd/hooks/git/${hook_name}" ]; then
      export HARNESS_ROOT="\$_configured_bd"
      exec "\$PROJECT_ROOT/\$_configured_bd/hooks/git/${hook_name}" "\$@"
    fi
    ;;
esac
for _bd in .codex .codebuddy .qoder .zcode .claude; do
  if [ -f "\$PROJECT_ROOT/\$_bd/hooks/git/${hook_name}" ]; then
    # 命中的 backend 目录（相对项目根，如 .codex）即 HARNESS_ROOT。export 给被 exec 的
    # hook：pre-commit/commit-msg 的源版本用字面 .claude/ 定位（不读此变量，无影响），
    # 但 generator 把 backend 副本里的 .claude/ 重写为 \$HARNESS_ROOT/，若不 export 则
    # set -u 下 "HARNESS_ROOT: unbound variable" 直接阻断所有 commit/push（issue: install-backend-verify）。
    export HARNESS_ROOT="\$_bd"
    exec "\$PROJECT_ROOT/\$_bd/hooks/git/${hook_name}" "\$@"
  fi
done
echo "[hook-trampoline] 未找到 ${hook_name} 的 backend 目录（已探测 .codex/.codebuddy/.qoder/.zcode/.claude）" >&2
exit 1
TRAMPOLINE

  chmod +x "$target"
  chmod +x "$hook_src" 2>/dev/null || true
  info "$hook_name hook (trampoline)"
}

# ============================================================
# 安装所有 hooks
# ============================================================
install_hooks() {
  if [ ! -d "$GIT_HOOKS_DIR" ]; then
    error "$GIT_HOOKS_DIR/ 目录不存在，请确认当前目录是 git 仓库"
    exit 1
  fi

  # 安装客户端 hooks
  install_single_hook "pre-commit"
  install_single_hook "commit-msg"
  install_single_hook "pre-push"

  info "客户端 hooks 部署完成"
}

# ============================================================
# 移除
# ============================================================
remove_hooks() {
  for hook_name in pre-commit commit-msg pre-push; do
    local target="$GIT_HOOKS_DIR/$hook_name"
    if [ -L "$target" ] || [ -f "$target" ]; then
      rm -f "$target"
      info "已移除 $hook_name hook"
    fi
  done

  info "hooks 已移除"
}

# ============================================================
# 检查状态
# ============================================================
check_status() {
  echo ""
  echo "AI Git 提交规范 Hook 状态检查"
  echo "================================"

  for hook_name in pre-commit commit-msg pre-push; do
    local target="$GIT_HOOKS_DIR/$hook_name"
    local src="$HOOKS_SRC/$hook_name"

    if [ -f "$target" ] && grep -q "$TRAMPOLINE_MARKER" "$target" 2>/dev/null; then
      info "$hook_name hook: 已安装（trampoline）"
    elif [ -L "$target" ]; then
      info "$hook_name hook: 已安装（符号链接 → $(readlink "$target")）"
      warn "  建议重新运行 setup-hooks.sh 迁移到 trampoline 模式"
    elif [ -f "$target" ]; then
      info "$hook_name hook: 已安装（复制模式）"
      warn "  建议重新运行 setup-hooks.sh 迁移到 trampoline 模式"
    else
      error "$hook_name hook: 未安装"
    fi

    [ -f "$src" ] && info "  源脚本: $src" || error "  源脚本不存在: $src"
  done
  echo ""
}

# ============================================================
# 主入口
# ============================================================
case "${1:-install}" in
  --remove|-r)
    remove_hooks
    ;;
  --check|-c|status)
    check_status
    ;;
  install|--install|-i)
    install_hooks
    echo ""
    info "部署完成！trampoline 模式，macOS/Linux/Windows 通用"
    info "  查看状态: bash $_BACKEND_DIR/tools/scripts/setup/setup-hooks.sh --check"
    ;;
  *)
    echo "用法: bash $_BACKEND_DIR/tools/scripts/setup/setup-hooks.sh [--remove|--check|install]"
    exit 1
    ;;
esac
