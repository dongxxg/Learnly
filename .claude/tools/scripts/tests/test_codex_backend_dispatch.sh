#!/usr/bin/env bash
# Tests for CodexBackend.dispatchSubAgent (Bug 2: shell escape 缺失)
#
# 背景：[730] dispatchSubAgent 用 `execSync(`codex ${args.join(' ')}`)`，
# combinedPrompt 是多行字符串（含角色定义、规则、特殊字符如 $ ` " ' ===），
# 直接 join(' ') 拼进 shell 命令，shell 解析失败。
#
# Bug 复现：
#   codex exec --sandbox read-only === 角色定义 === ... (multiline)
#   shell 把 === 当作奇怪 token，prompt 中含未闭合引号、反引号、$ 都会炸。
#
# 修复要求：用 execFileSync('codex', args) 不经 shell。
#
# 本测试覆盖（用 fake codex 脚本接收 args，把收到的 argv 写到临时文件便于断言，
#             避免依赖真实 codex 鉴权）：
#   1) PASS: dispatchSubAgent 不抛 shell 解析错误（fake codex 被调用，文件非空）
#   2) PASS: fake codex 收到完整 prompt（含 === 角色定义 === 标记 + 完整多行 + 特殊字符）
#   3) PASS: fake codex 收到 sandbox 参数（read-only / workspace-write）
#   4) PASS: dispatchSubAgent 返回结构化结果（含 exitStatus 字段）
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR"/../../../.. && pwd)"
CODEX_BACKEND="$PROJECT_ROOT/.claude/backends/codex-backend.js"
RULES_YAML="$PROJECT_ROOT/.claude/reference/harness-rules.yaml"
AGENTS_DIR="$PROJECT_ROOT/.claude/agents"

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

# fake codex 脚本：把收到的 argv 写入 CAPTURE_FILE，stdout 输出 "Done" 标记
# 通过环境变量 CODEX_CAPTURE_FILE 传递目标文件路径
cat > "$FAKE_BIN/codex" <<'EOF'
#!/usr/bin/env bash
# 把所有 argv 写入 capture 文件，每个 arg 用 ===ARG<N>=== 分隔
{
  echo "ARGC=$#"
  i=0
  for arg in "$@"; do
    echo "===ARG${i}==="
    printf '%s\n' "$arg"
    i=$((i + 1))
  done
} > "$CODEX_CAPTURE_FILE"
# stdout 给 dispatchSubAgent 用（_parseOutput 会读 stdout）
echo "Done: task completed"
EOF
chmod +x "$FAKE_BIN/codex"

# 测试函数：调用 dispatchSubAgent（fake codex 在 PATH 中），返回 JSON 结果到 stdout
# 同时 fake codex 把 args 写入 $CAPTURE_FILE
call_dispatch() {
    local prompt="$1"
    local context_mode="${2:-read_only}"
    : > "$CAPTURE_FILE"  # 清空 capture 文件
    HARNESS_PROMPT="$prompt" \
    HARNESS_CONTEXT_MODE="$context_mode" \
    MODULE_PATH="${CODEX_BACKEND}" \
    RULES_PATH="${RULES_YAML}" \
    PATH="$FAKE_BIN:${PATH}" \
    CLAUDE_PROJECT_DIR="$PROJECT_ROOT" \
    CODEX_CAPTURE_FILE="$CAPTURE_FILE" \
    node --input-type=module -e '
const { pathToFileURL } = await import("node:url");
const { CodexBackend } = await import(pathToFileURL(process.env.MODULE_PATH).href);
const backend = new CodexBackend({ rulesPath: process.env.RULES_PATH });
const prompt = process.env.HARNESS_PROMPT;
const contextMode = process.env.HARNESS_CONTEXT_MODE;
const result = await backend.dispatchSubAgent("developer", prompt, {
  acceptanceCriteria: ["criterion 1", "criterion with `backtick` and $var"],
  contextMode,
});
console.log(JSON.stringify(result));
' 2>&1
}

echo "=== CodexBackend dispatchSubAgent Tests (Bug 2: shell escape) ==="
echo ""

# Case 1: 简单 prompt 不抛 shell 错误（fake codex 被调用且 capture 文件非空）
echo "Test 1: 简单 prompt 调用 dispatchSubAgent 不抛 shell 错误"
OUT=$(call_dispatch "implement feature X" read_only || true)
if [ -s "$CAPTURE_FILE" ] && grep -q '^ARGC=' "$CAPTURE_FILE"; then
    ARGC=$(grep '^ARGC=' "$CAPTURE_FILE" | head -1 | cut -d= -f2)
    echo "  [PASS] fake codex 被调用 (ARGC=$ARGC)"
    PASS=$((PASS + 1))
else
    echo "  [FAIL] fake codex 未被调用（capture 文件为空）"
    echo "        node output: $(echo "$OUT" | tail -5 | sed 's/^/        /')"
    FAIL=$((FAIL + 1))
fi
echo ""

# Case 2: 含 shell 元字符的 prompt 完整传输
echo "Test 2: prompt 含 shell 元字符 (\$ \` \" ' === 换行) 完整传输"
NASTY_PROMPT='Implement `feature $X` with "quotes" and '"'"'single'"'"' and ===
multi
line
with $VAR expansion attempts'
OUT=$(call_dispatch "$NASTY_PROMPT" read_only || true)

# 从 capture 文件断言
# Phase 3a 起：codexArgs 增加 --json；Codex CLI 0.153+ 移除 --full-auto，
# ARGC 仍为 5（exec / --json / --sandbox / mode / prompt）
CAPTURE_OK=1
if ! grep -q '^ARGC=5$' "$CAPTURE_FILE"; then
    echo "  [debug] ARGC != 5 (期望 5：含 --json，不含 --full-auto)"
    CAPTURE_OK=0
fi
# ARG4 是 prompt（最后位置），断言其中含完整特殊字符和多行
PROMPT_SECTION=$(sed -n '/^===ARG4===$/,$p' "$CAPTURE_FILE" | tail -n +2)
if ! echo "$PROMPT_SECTION" | grep -q 'feature $X'; then
    echo "  [debug] missing 'feature \$X'"
    CAPTURE_OK=0
fi
if ! echo "$PROMPT_SECTION" | grep -q 'with "quotes"'; then
    echo "  [debug] missing 'with \"quotes\"'"
    CAPTURE_OK=0
fi
if ! echo "$PROMPT_SECTION" | grep -q "and 'single'"; then
    echo "  [debug] missing single quotes"
    CAPTURE_OK=0
fi
if ! echo "$PROMPT_SECTION" | grep -q '^multi$'; then
    echo "  [debug] missing 'multi' line"
    CAPTURE_OK=0
fi
if ! echo "$PROMPT_SECTION" | grep -q 'with $VAR expansion attempts'; then
    echo "  [debug] missing '\$VAR expansion attempts'"
    CAPTURE_OK=0
fi
# prompt 中的 === 必须保留
if ! echo "$PROMPT_SECTION" | grep -q "==="; then
    echo "  [debug] missing === marker"
    CAPTURE_OK=0
fi

if [ "$CAPTURE_OK" -eq 1 ]; then
    echo "  [PASS] prompt 含特殊字符完整传输 (ARGC=5, prompt 不被 shell 损坏)"
    PASS=$((PASS + 1))
else
    echo "  [FAIL] prompt 被截断或损坏"
    echo "        capture file content:"
    sed 's/^/        /' "$CAPTURE_FILE" | head -20
    FAIL=$((FAIL + 1))
fi
echo ""

# Case 3: sandbox 参数正确传递
echo "Test 3: sandbox 参数正确传递 (read_only -> danger-full-access)"
OUT=$(call_dispatch "test prompt" read_only || true)
# Phase 3a: codexArgs = [exec, --json, --sandbox, mode, prompt]
# ARG2 应是 --sandbox，ARG3 应是 read-only
if grep -q '^===ARG2===' "$CAPTURE_FILE" && sed -n '/^===ARG2===$/,/^===ARG/p' "$CAPTURE_FILE" | grep -q -- '--sandbox' \
   && sed -n '/^===ARG3===$/,/^===ARG/p' "$CAPTURE_FILE" | grep -q -- 'danger-full-access'; then
    echo "  [PASS] sandbox=danger-full-access 传递"
    PASS=$((PASS + 1))
else
    echo "  [FAIL] sandbox 参数缺失"
    sed 's/^/        /' "$CAPTURE_FILE" | head -10
    FAIL=$((FAIL + 1))
fi
echo ""

echo "Test 3b: sandbox 参数正确传递 (full -> danger-full-access)"
OUT=$(call_dispatch "test prompt" full || true)
if grep -q '^===ARG2===' "$CAPTURE_FILE" && sed -n '/^===ARG2===$/,/^===ARG/p' "$CAPTURE_FILE" | grep -q -- '--sandbox' \
   && sed -n '/^===ARG3===$/,/^===ARG/p' "$CAPTURE_FILE" | grep -q -- 'danger-full-access'; then
    echo "  [PASS] sandbox=danger-full-access 传递"
    PASS=$((PASS + 1))
else
    echo "  [FAIL] full→danger-full-access 映射失败"
    sed 's/^/        /' "$CAPTURE_FILE" | head -10
    FAIL=$((FAIL + 1))
fi
echo ""

# Case 4: dispatchSubAgent 返回结构化结果
echo "Test 4: dispatchSubAgent 返回含 exitStatus 字段的对象"
OUT=$(call_dispatch "test prompt" read_only || true)
JSON_LINE=$(echo "$OUT" | grep -E '^\{' | tail -1)
if [ -n "$JSON_LINE" ]; then
    EXIT_STATUS=$(echo "$JSON_LINE" | node -e 'let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{try{const o=JSON.parse(s); console.log(o.exitStatus||"")}catch(e){console.log("PARSE_ERROR")}})' 2>/dev/null || echo "PARSE_ERROR")
    if [ "$EXIT_STATUS" != "PARSE_ERROR" ] && [ -n "$EXIT_STATUS" ]; then
        echo "  [PASS] 返回结构化对象 (exitStatus=$EXIT_STATUS)"
        PASS=$((PASS + 1))
    else
        echo "  [FAIL] 返回的 JSON 无法解析"
        echo "        line: $(echo "$JSON_LINE" | head -c 200)"
        echo ""
        FAIL=$((FAIL + 1))
    fi
else
    echo "  [FAIL] 没有输出 JSON 行"
    echo "$OUT" | tail -5 | sed 's/^/        /'
    FAIL=$((FAIL + 1))
fi
echo ""

echo "=== Results: ${PASS} passed, ${FAIL} failed ==="
[ "$FAIL" -eq 0 ] || exit 1
