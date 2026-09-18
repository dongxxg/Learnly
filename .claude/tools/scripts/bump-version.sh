#!/usr/bin/env bash
# 框架版本号升级，自动更新所有关联文件 + 生成签名
# 用法: bash .claude/tools/scripts/bump-version.sh <新版本号> [force]
set -euo pipefail

NEW_VERSION="${1:-}"
FORCE_FLAG="${2:-}"

if [ -z "$NEW_VERSION" ]; then
  echo "用法: $0 <新版本号> [force]" >&2
  echo "示例: $0 1.17.0        # 非强制升级" >&2
  echo "      $0 1.16.2 force  # 强制升级" >&2
  exit 1
fi

SIGN_SALT="rd-harness-v2"
SIGNATURE=$(echo -n "${NEW_VERSION}${SIGN_SALT}" | sha256sum | cut -c1-8)
ROOT_DIR="$(cd "$(dirname "$0")/../../.." && pwd)"

echo "=== 版本升级检查清单 ==="
echo ""

# 1. .harness-version
echo "[1/2] 更新 .harness/.harness-version → $NEW_VERSION $FORCE_FLAG"
cat > "$ROOT_DIR/.harness/.harness-version" <<EOF
$NEW_VERSION
$FORCE_FLAG
$SIGNATURE
EOF
echo "  签名: $SIGNATURE"

# 2. CHANGELOG.md (提示手动编辑)
echo "[2/2] ⚠️  CHANGELOG.md 需要手动更新"
echo "   请在 CHANGELOG.md 顶部添加 v$NEW_VERSION 条目"

echo ""
echo "=== 版本升级只需三步 ==="
echo "1. 编辑 CHANGELOG.md 添加 v$NEW_VERSION 变更内容"
echo "2. git add .harness/.harness-version CHANGELOG.md"
echo '3. git commit -m "[0000] REL 版本管理[AI-<user>.Developer]"'
