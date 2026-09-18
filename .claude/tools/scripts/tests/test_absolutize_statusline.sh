#!/usr/bin/env bash
# test_absolutize_statusline.sh — absolutize-statusline.cjs 行为测试。
# 覆盖：相对路径改写为绝对（形态 A）/ 幂等（已是当前绝对不再改，形态 C）/
#       仓库 move 后旧绝对前缀校准（形态 B）/ backend 目录泛化 / 无 statusLine 不动 / 缺文件退 0。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOL="$SCRIPT_DIR/../setup/absolutize-statusline.cjs"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

fail() { echo "[test_absolutize_statusline] FAIL: $1" >&2; exit 1; }

mkdir -p "$TMP/proj/.claude"

# ── 1. 相对路径 → 绝对路径 ──
cat > "$TMP/proj/.claude/settings.json" <<'EOF'
{
  "statusLine": {
    "type": "command",
    "command": "node \".claude/tools/scripts/statusline/statusline-command.cjs\"",
    "refreshInterval": 60
  },
  "permissions": {
    "defaultMode": "bypassPermissions"
  }
}
EOF
node "$TOOL" "$TMP/proj/.claude/settings.json" >/dev/null
CMD=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).statusLine.command)' "$TMP/proj/.claude/settings.json")
EXPECT="node \"$TMP/proj/.claude/tools/scripts/statusline/statusline-command.cjs\""
[ "$CMD" = "$EXPECT" ] || fail "改写结果错误: $CMD"
# 其余字段保留
node -e '
  const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  if (s.statusLine.refreshInterval !== 60) process.exit(1);
  if (s.permissions.defaultMode !== "bypassPermissions") process.exit(1);
' "$TMP/proj/.claude/settings.json" || fail "非 statusLine 字段被改动"

# ── 2. 幂等：再跑一次不变 ──
BEFORE=$(cat "$TMP/proj/.claude/settings.json")
node "$TOOL" "$TMP/proj/.claude/settings.json" >/dev/null
AFTER=$(cat "$TMP/proj/.claude/settings.json")
[ "$BEFORE" = "$AFTER" ] || fail "不幂等：二次运行改动了文件"

# ── 3. 无 statusLine：文件内容不变（round-trip 亦不重排） ──
mkdir -p "$TMP/empty/.claude"
printf '{\n  "permissions": {\n    "allow": []\n  }\n}\n' > "$TMP/empty/.claude/settings.json"
B3=$(cat "$TMP/empty/.claude/settings.json")
node "$TOOL" "$TMP/empty/.claude/settings.json" >/dev/null
[ "$B3" = "$(cat "$TMP/empty/.claude/settings.json")" ] || fail "无 statusLine 的文件被改动"

# ── 4. 缺文件 / 非法 JSON：退出码 0 ──
node "$TOOL" "$TMP/nonexistent/settings.json" >/dev/null 2>&1 || fail "缺文件应退 0"
echo 'not-json' > "$TMP/proj/.claude/bad.json"
node "$TOOL" "$TMP/proj/.claude/bad.json" >/dev/null 2>&1 || fail "非法 JSON 应退 0"

# ── 5. hooks 里的字面量 .claude/（无引号锚定形态，如 `bash .claude/hooks/...`）也改写 ──
mkdir -p "$TMP/proj2/.claude"
cat > "$TMP/proj2/.claude/settings.json" <<'EOF'
{
  "statusLine": {
    "type": "command",
    "command": "node .claude/tools/scripts/statusline/statusline-command.cjs"
  }
}
EOF
node "$TOOL" "$TMP/proj2/.claude/settings.json" >/dev/null
CMD5=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).statusLine.command)' "$TMP/proj2/.claude/settings.json")
[ "$CMD5" = "node $TMP/proj2/.claude/tools/scripts/statusline/statusline-command.cjs" ] || fail "无引号形态改写错误: $CMD5"

# ── 6. move 自愈（形态 B）：旧绝对前缀 → 当前位置 ──
# 模拟仓库从 /old/place move 到 $TMP：settings.json 里仍是旧绝对路径
mkdir -p "$TMP/moved/.claude"
cat > "$TMP/moved/.claude/settings.json" <<EOF
{
  "statusLine": {
    "type": "command",
    "command": "node \"/old/place/.claude/tools/scripts/statusline/statusline-command.cjs\""
  }
}
EOF
node "$TOOL" "$TMP/moved/.claude/settings.json" >/dev/null
CMD6=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).statusLine.command)' "$TMP/moved/.claude/settings.json")
[ "$CMD6" = "node \"$TMP/moved/.claude/tools/scripts/statusline/statusline-command.cjs\"" ] || fail "move 校准错误: $CMD6"

# ── 7. backend 目录泛化：.codebuddy/settings.json 的旧绝对前缀同样校准 ──
mkdir -p "$TMP/cb/.codebuddy"
cat > "$TMP/cb/.codebuddy/settings.json" <<EOF
{
  "statusLine": {
    "type": "command",
    "command": "node \"/old/place/.codebuddy/tools/scripts/statusline/statusline-command.cjs\""
  }
}
EOF
node "$TOOL" "$TMP/cb/.codebuddy/settings.json" >/dev/null
CMD7=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).statusLine.command)' "$TMP/cb/.codebuddy/settings.json")
[ "$CMD7" = "node \"$TMP/cb/.codebuddy/tools/scripts/statusline/statusline-command.cjs\"" ] || fail "codebuddy move 校准错误: $CMD7"

echo "test_absolutize_statusline: all tests passed"
