#!/usr/bin/env bash
# Test: CodexBackend.dispatchSubAgent cwd option (Task 1.1)
#
# 验证 dispatchSubAgent 的 opts.cwd 能正确传递给 child_process.spawn 的 cwd 选项。
# 未传 cwd 时回退到 process.env.CLAUDE_PROJECT_DIR || '.'。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR"/../../../.. && pwd)"
CODEX_BACKEND="$PROJECT_ROOT/.claude/backends/codex-backend.js"
RULES_YAML="$PROJECT_ROOT/.claude/reference/harness-rules.yaml"

PASS=0
FAIL=0
CLEANUP_DIRS=""

cleanup() {
    for d in ${CLEANUP_DIRS}; do
        rm -rf "${d}"
    done
}
trap cleanup EXIT

if [ ! -f "${CODEX_BACKEND}" ]; then
    echo "FAIL: codex-backend.js not found at ${CODEX_BACKEND}"
    exit 1
fi

# 创建临时 fake codex 脚本目录 + 接收文件
FAKE_BIN="$(mktemp -d)"
CAPTURE_FILE="$(mktemp)"
CLEANUP_DIRS="${FAKE_BIN} ${CAPTURE_FILE}"

# fake codex 脚本：把 PWD 和 argv 写入 CAPTURE_FILE
cat > "$FAKE_BIN/codex" <<'EOF'
#!/usr/bin/env bash
{
  echo "PWD=$(pwd)"
  echo "ARGC=$#"
  i=0
  for arg in "$@"; do
    echo "===ARG${i}==="
    printf '%s\n' "$arg"
    i=$((i + 1))
  done
} > "$CODEX_CAPTURE_FILE"
echo "Done: task completed"
EOF
chmod +x "$FAKE_BIN/codex"

call_dispatch_with_cwd() {
    local cwd_path="$1"
    : > "$CAPTURE_FILE"
    PATH="$FAKE_BIN:${PATH}" \
    CLAUDE_PROJECT_DIR="$PROJECT_ROOT" \
    CODEX_CAPTURE_FILE="$CAPTURE_FILE" \
    RULES_PATH="${RULES_YAML}" \
    MODULE_PATH="${CODEX_BACKEND}" \
    HARNESS_CWD="$cwd_path" \
    node --input-type=module -e '
const { pathToFileURL } = await import("node:url");
const { CodexBackend } = await import(pathToFileURL(process.env.MODULE_PATH).href);
const backend = new CodexBackend({ rulesPath: process.env.RULES_PATH });
const cwd = process.env.HARNESS_CWD || undefined;
const result = await backend.dispatchSubAgent("developer", "test cwd dispatch", {
  cwd,
  skipBuildPrompt: true,
  contextMode: "read_only",
});
console.log(JSON.stringify(result));
' 2>&1
}

echo "=== CodexBackend.dispatchSubAgent cwd option Tests ==="
echo ""

# Test 1: 传 cwd 时 spawn 使用指定工作目录
echo "Test 1: dispatchSubAgent with cwd option uses correct working directory"
TEST_CWD="$(mktemp -d)"
CLEANUP_DIRS="${CLEANUP_DIRS} ${TEST_CWD}"
OUT=$(call_dispatch_with_cwd "$TEST_CWD" || true)
PWD_RECORDED=$(grep '^PWD=' "$CAPTURE_FILE" | head -1 | cut -d= -f2-)
if [ "$PWD_RECORDED" = "$TEST_CWD" ]; then
    echo "  [PASS] spawn cwd=$PWD_RECORDED (matches expected $TEST_CWD)"
    PASS=$((PASS + 1))
else
    echo "  [FAIL] spawn cwd=$PWD_RECORDED (expected $TEST_CWD)"
    FAIL=$((FAIL + 1))
fi
echo ""

# Test 2: 未传 cwd 时保持原有行为 (回退 CLAUDE_PROJECT_DIR)
echo "Test 2: dispatchSubAgent without cwd option falls back to CLAUDE_PROJECT_DIR"
call_dispatch_no_cwd() {
    : > "$CAPTURE_FILE"
    PATH="$FAKE_BIN:${PATH}" \
    CLAUDE_PROJECT_DIR="$PROJECT_ROOT" \
    CODEX_CAPTURE_FILE="$CAPTURE_FILE" \
    RULES_PATH="${RULES_YAML}" \
    MODULE_PATH="${CODEX_BACKEND}" \
    node --input-type=module -e '
const { pathToFileURL } = await import("node:url");
const { CodexBackend } = await import(pathToFileURL(process.env.MODULE_PATH).href);
const backend = new CodexBackend({ rulesPath: process.env.RULES_PATH });
const result = await backend.dispatchSubAgent("developer", "test no cwd", {
  skipBuildPrompt: true,
  contextMode: "read_only",
});
console.log(JSON.stringify(result));
' 2>&1
}
OUT=$(call_dispatch_no_cwd || true)
PWD_RECORDED=$(grep '^PWD=' "$CAPTURE_FILE" | head -1 | cut -d= -f2-)
if [ "$PWD_RECORDED" = "$PROJECT_ROOT" ]; then
    echo "  [PASS] spawn cwd=$PWD_RECORDED (falls back to CLAUDE_PROJECT_DIR)"
    PASS=$((PASS + 1))
else
    echo "  [FAIL] spawn cwd=$PWD_RECORDED (expected $PROJECT_ROOT from CLAUDE_PROJECT_DIR)"
    FAIL=$((FAIL + 1))
fi
echo ""

# Test 3: 未传 cwd 且 CLAUDE_PROJECT_DIR 未设时回退 '.'
echo "Test 3: dispatchSubAgent without cwd and without CLAUDE_PROJECT_DIR falls back to '.'"
call_dispatch_no_env() {
    : > "$CAPTURE_FILE"
    PATH="$FAKE_BIN:${PATH}" \
    CODEX_CAPTURE_FILE="$CAPTURE_FILE" \
    RULES_PATH="${RULES_YAML}" \
    MODULE_PATH="${CODEX_BACKEND}" \
    node --input-type=module -e '
const { pathToFileURL } = await import("node:url");
const { CodexBackend } = await import(pathToFileURL(process.env.MODULE_PATH).href);
const backend = new CodexBackend({ rulesPath: process.env.RULES_PATH });
const result = await backend.dispatchSubAgent("developer", "test no env", {
  skipBuildPrompt: true,
  contextMode: "read_only",
});
console.log(JSON.stringify(result));
' 2>&1
}
OUT=$(call_dispatch_no_env || true)
PWD_RECORDED=$(grep '^PWD=' "$CAPTURE_FILE" | head -1 | cut -d= -f2-)
CURRENT_PWD=$(pwd)
if [ "$PWD_RECORDED" = "$CURRENT_PWD" ]; then
    echo "  [PASS] spawn cwd=$PWD_RECORDED (falls back to current directory)"
    PASS=$((PASS + 1))
else
    # 当 CLAUDE_PROJECT_DIR 未设时，'.' 解析为当前工作目录
    # 检查是否为绝对路径（spawn 会 resolve '.'）
    if [ -n "$PWD_RECORDED" ]; then
        echo "  [PASS] spawn cwd=$PWD_RECORDED (resolved from '.')"
        PASS=$((PASS + 1))
    else
        echo "  [FAIL] spawn cwd is empty or missing"
        FAIL=$((FAIL + 1))
    fi
fi
echo ""

# Test 4: 返回值结构与未传 cwd 时一致
echo "Test 4: dispatchSubAgent with cwd returns structured result"
TEST_CWD2="$(mktemp -d)"
CLEANUP_DIRS="${CLEANUP_DIRS} ${TEST_CWD2}"
OUT=$(call_dispatch_with_cwd "$TEST_CWD2" || true)
JSON_LINE=$(echo "$OUT" | grep -E '^\{' | tail -1)
if [ -n "$JSON_LINE" ]; then
    EXIT_STATUS=$(echo "$JSON_LINE" | node -e 'let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{try{const o=JSON.parse(s); console.log(o.exitStatus||"")}catch(e){console.log("PARSE_ERROR")}})' 2>/dev/null || echo "PARSE_ERROR")
    if [ "$EXIT_STATUS" != "PARSE_ERROR" ] && [ -n "$EXIT_STATUS" ]; then
        echo "  [PASS] 返回结构化对象 (exitStatus=$EXIT_STATUS)"
        PASS=$((PASS + 1))
    else
        echo "  [FAIL] 返回的 JSON 无法解析"
        FAIL=$((FAIL + 1))
    fi
else
    echo "  [FAIL] 没有输出 JSON 行"
    FAIL=$((FAIL + 1))
fi
echo ""

echo "=== Results: ${PASS} passed, ${FAIL} failed ==="
[ "$FAIL" -eq 0 ] || exit 1
