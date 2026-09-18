#!/usr/bin/env bash
# e2e 测试：codex 模式 dispatch 全链路（tasks 8.1-8.6）
#
# 通过 fake codex（tests/fakes/codex）模拟 codex CLI，覆盖 5 个场景：
#   (a) 成功路径：fake codex 返回 DONE JSON
#   (b) 鉴权失败：fake codex 返回 401 → BLOCKED + escalate_reason
#   (c) 超时：fake codex sleep > timeout → 重试 → 仍超时 BLOCKED
#   (d) 输出不可解析：fake codex 返回纯文本 → DONE_WITH_CONCERNS + codex-logs 落盘
#   (e) 校验 codex-logs 文件命名格式 <role>-<round>-<timestamp>.txt
#
# 同时验证：
#   - dispatch-prompt 输出含 backend.type === "codex"
#   - 主会话 normalize 后的字段语义
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR"/../../../.. && pwd)"
CODEX_BACKEND="$PROJECT_ROOT/.claude/backends/codex-backend.js"
NORMALIZE_MOD="$PROJECT_ROOT/.claude/skills/rd-auto/scripts/lib/normalize-result.js"
RULES_YAML="$PROJECT_ROOT/.claude/reference/harness-rules.yaml"
FAKE_CODEX_DIR="$SCRIPT_DIR/fakes"
ORCH="$PROJECT_ROOT/.claude/skills/rd-auto/scripts/orchestrator.js"

PASS=0
FAIL=0
TMP_DIRS=""

cleanup() {
    for d in $TMP_DIRS; do
        rm -rf "$d" 2>/dev/null || true
    done
}
trap cleanup EXIT

WORK_DIR="$(mktemp -d -t codex-e2e-XXXXXX)"
TMP_DIRS="$WORK_DIR"

# 临时 change 目录用于 codex-logs 落盘（_writeCodexLog 用 REPO_ROOT/.harness/shared-state）
SHARED_STATE_DIR="$PROJECT_ROOT/.harness/shared-state/test-codex-e2e"
rm -rf "$SHARED_STATE_DIR" 2>/dev/null || true
TMP_DIRS="$TMP_DIRS $SHARED_STATE_DIR"

# 调用 CodexBackend.dispatchSubAgent（fake codex 在 PATH 中）
# 用法：call_dispatch <mode> [extra env]
call_dispatch() {
    local mode="$1"
    local extra_env="$2"
    HARNESS_FAKE_CODEX_MODE="$mode" \
    HARNESS_FAKE_CODEX_CAPTURE="$WORK_DIR/capture-$mode.txt" \
    HARNESS_FAKE_CODEX_STDIN_FILE="$WORK_DIR/stdin-$mode.txt" \
    PATH="$FAKE_BIN:$PATH" \
    CLAUDE_PROJECT_DIR="$PROJECT_ROOT" \
    MODULE_PATH="$CODEX_BACKEND" \
    RULES_PATH="$RULES_YAML" \
    CHANGE_NAME="test-codex-e2e" \
    TIMEOUT_MS="$MODE_TIMEOUT_MS" \
    node --input-type=module -e '
const { pathToFileURL } = await import("node:url");
const mod = await import(pathToFileURL(process.env.MODULE_PATH).href);
const backend = new mod.CodexBackend({ rulesPath: process.env.RULES_PATH });
const result = await backend.dispatchSubAgent("developer", "test prompt for " + process.env.HARNESS_FAKE_CODEX_MODE, {
    skipBuildPrompt: true,
    phase: "implement",
    changeName: process.env.CHANGE_NAME,
    round: 1,
    timeoutMs: Number(process.env.TIMEOUT_MS || 600000),
});
console.log("RESULT_JSON:" + JSON.stringify(result));
' 2>&1
}

# 设置 fake codex 在 PATH 前面
FAKE_BIN="$WORK_DIR/bin"
mkdir -p "$FAKE_BIN"
cp "$FAKE_CODEX_DIR/codex" "$FAKE_BIN/codex"
chmod +x "$FAKE_BIN/codex"

# 默认 timeout（除非测 timeout 场景，否则给一个较大值避免误触发）
MODE_TIMEOUT_MS=600000

echo "=== Codex Backend e2e Tests (tasks 8.1-8.6) ==="
echo ""

# ─── Test 0: dispatch-prompt 输出含 backend.type === "codex" ───
echo "Test 0: dispatch-prompt 在 HARNESS_BACKEND=codex 时输出 backend.type=codex"
# 初始化一个临时 change
HARNESS_BACKEND=codex node "$ORCH" init test-codex-e2e \
    --flow-type development \
    --intent-json '{"task_type":"feature","intent_category":"feature_dev","confidence":0.9,"affected_files":["x"],"complexity_hint":"M"}' \
    --criteria "test" > /dev/null 2>&1 || true
DP_OUT=$(HARNESS_BACKEND=codex node "$ORCH" dispatch-prompt test-codex-e2e 2>&1)
BACKEND_TYPE=$(echo "$DP_OUT" | node -e '
let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
    try { const j = JSON.parse(s); console.log(j.backend?.type || ""); }
    catch (e) { console.log(""); }
});' 2>/dev/null || echo "")
if [ "$BACKEND_TYPE" = "codex" ]; then
    echo "  [PASS] dispatch-prompt 输出 backend.type=codex"
    PASS=$((PASS + 1))
else
    echo "  [FAIL] dispatch-prompt backend.type != codex (got: '$BACKEND_TYPE')"
    FAIL=$((FAIL + 1))
fi
# 清理临时 change
rm -rf "$PROJECT_ROOT/.harness/spec/changes/test-codex-e2e" "$PROJECT_ROOT/.harness/tasks/test-codex-e2e" 2>/dev/null || true
echo ""

# ─── Test (a) 成功路径 ───
echo "Test (a) 成功路径：fake codex 返回 DONE JSON"
OUT=$(call_dispatch "success" "" || true)
RESULT=$(echo "$OUT" | grep '^RESULT_JSON:' | sed 's/^RESULT_JSON://')
if [ -n "$RESULT" ]; then
    EXIT_STATUS=$(echo "$RESULT" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);console.log(o.exitStatus)})')
    SUMMARY=$(echo "$RESULT" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);console.log(o.summary||"")})')
    SCORE=$(echo "$RESULT" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);console.log(o.score||"")})')
    if [ "$EXIT_STATUS" = "DONE" ] && [ -n "$SUMMARY" ]; then
        echo "  [PASS] exitStatus=DONE, summary 存在, score=$SCORE"
        PASS=$((PASS + 1))
    else
        echo "  [FAIL] exitStatus=$EXIT_STATUS summary=$SUMMARY"
        FAIL=$((FAIL + 1))
    fi
else
    echo "  [FAIL] 没拿到 RESULT_JSON"
    echo "$OUT" | tail -5 | sed 's/^/        /'
    FAIL=$((FAIL + 1))
fi
echo ""

# ─── Test (b) 鉴权失败 ───
echo "Test (b) 鉴权失败：fake codex 返回 401 → BLOCKED + escalate_reason"
OUT=$(call_dispatch "auth_fail" "" || true)
RESULT=$(echo "$OUT" | grep '^RESULT_JSON:' | sed 's/^RESULT_JSON://')
if [ -n "$RESULT" ]; then
    EXIT_STATUS=$(echo "$RESULT" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);console.log(o.exitStatus)})')
    ERR_TYPE=$(echo "$RESULT" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);console.log(o.error?.type||"")})')
    if [ "$EXIT_STATUS" = "BLOCKED" ] && [ "$ERR_TYPE" = "auth_failure" ]; then
        echo "  [PASS] exitStatus=BLOCKED, error.type=auth_failure（不重试）"
        PASS=$((PASS + 1))
    else
        echo "  [FAIL] exitStatus=$EXIT_STATUS error.type=$ERR_TYPE"
        echo "$RESULT" | sed 's/^/        /'
        FAIL=$((FAIL + 1))
    fi
else
    echo "  [FAIL] 没拿到 RESULT_JSON"
    echo "$OUT" | tail -5 | sed 's/^/        /'
    FAIL=$((FAIL + 1))
fi
echo ""

# ─── Test (c) 超时（用极短 timeoutMs 触发） ───
echo "Test (c) 超时：fake codex sleep > timeoutMs=200 → 重试 → 仍超时 BLOCKED"
OUT=$(MODE_TIMEOUT_MS=200 HARNESS_FAKE_CODEX_TIMEOUT_SLEEP=10 call_dispatch "timeout" "" || true)
RESULT=$(echo "$OUT" | grep '^RESULT_JSON:' | sed 's/^RESULT_JSON://')
if [ -n "$RESULT" ]; then
    EXIT_STATUS=$(echo "$RESULT" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);console.log(o.exitStatus)})')
    ERR_TYPE=$(echo "$RESULT" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);console.log(o.error?.type||"")})')
    if [ "$EXIT_STATUS" = "BLOCKED" ] && [ "$ERR_TYPE" = "timeout" ]; then
        echo "  [PASS] exitStatus=BLOCKED, error.type=timeout"
        PASS=$((PASS + 1))
    else
        echo "  [FAIL] exitStatus=$EXIT_STATUS error.type=$ERR_TYPE"
        echo "$RESULT" | sed 's/^/        /'
        FAIL=$((FAIL + 1))
    fi
else
    echo "  [FAIL] 没拿到 RESULT_JSON"
    echo "$OUT" | tail -5 | sed 's/^/        /'
    FAIL=$((FAIL + 1))
fi
echo ""

# ─── Test (d) 输出不可解析 ───
echo "Test (d) 输出不可解析：fake codex 返回纯文本 → DONE_WITH_CONCERNS"
OUT=$(call_dispatch "unparseable" "" || true)
RESULT=$(echo "$OUT" | grep '^RESULT_JSON:' | sed 's/^RESULT_JSON://')
if [ -n "$RESULT" ]; then
    EXIT_STATUS=$(echo "$RESULT" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);console.log(o.exitStatus)})')
    CONCERN_TYPE=$(echo "$RESULT" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);console.log((o.concerns||[]).map(c=>c.type).join(","))})')
    if [ "$EXIT_STATUS" = "DONE_WITH_CONCERNS" ] && [ "$CONCERN_TYPE" = "unparseable-codex-output" ]; then
        echo "  [PASS] exitStatus=DONE_WITH_CONCERNS, concerns 含 unparseable-codex-output"
        PASS=$((PASS + 1))
    else
        echo "  [FAIL] exitStatus=$EXIT_STATUS concern_type=$CONCERN_TYPE"
        FAIL=$((FAIL + 1))
    fi
else
    echo "  [FAIL] 没拿到 RESULT_JSON"
    FAIL=$((FAIL + 1))
fi
echo ""

# ─── Test (e) 校验 codex-logs 文件命名格式 ───
echo "Test (e) 校验 codex-logs 文件命名格式 <role>-<round>-<timestamp>.txt"
LOGS_DIR="$SHARED_STATE_DIR/codex-logs"
if [ -d "$LOGS_DIR" ]; then
    LOG_FILE=$(ls -1 "$LOGS_DIR" 2>/dev/null | head -1)
    if [ -n "$LOG_FILE" ]; then
        # 期望格式：developer-1-<14位时间戳>.txt
        if echo "$LOG_FILE" | grep -qE '^developer-1-[0-9]{14}\.txt$'; then
            echo "  [PASS] codex-logs 命名格式正确: $LOG_FILE"
            PASS=$((PASS + 1))
        else
            echo "  [FAIL] codex-logs 命名格式不符: $LOG_FILE (期望 developer-1-YYYYMMDDHHMMSS.txt)"
            FAIL=$((FAIL + 1))
        fi
        # 验证文件非空
        if [ -s "$LOGS_DIR/$LOG_FILE" ]; then
            echo "  [PASS] codex-logs 文件非空"
            PASS=$((PASS + 1))
        else
            echo "  [FAIL] codex-logs 文件为空"
            FAIL=$((FAIL + 1))
        fi
    else
        echo "  [FAIL] codex-logs 目录下无文件"
        FAIL=$((FAIL + 1))
    fi
else
    echo "  [FAIL] codex-logs 目录不存在: $LOGS_DIR"
    FAIL=$((FAIL + 1))
fi
echo ""

# ─── Test normalize 集成：codex BLOCKED → escalate_reason ───
echo "Test (f) normalize 集成：codex auth_fail BLOCKED → escalate_reason 含 auth_failure"
# 直接构造 codex BLOCKED 原始结果（与 Test b 一致），调 normalize 验证字段映射
NORM=$(RAW='{"exitStatus":"BLOCKED","error":{"type":"auth_failure","message":"401 Unauthorized"}}' \
    HARNESS_MODULE_PATH="$NORMALIZE_MOD" \
    node --input-type=module -e '
import { pathToFileURL } from "node:url";
const mod = await import(pathToFileURL(process.env.HARNESS_MODULE_PATH).href);
const raw = JSON.parse(process.env.RAW);
const out = mod.normalizeDispatchResult("codex", raw);
console.log(JSON.stringify(out));
' 2>&1)
ESCALATE=$(echo "$NORM" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const o=JSON.parse(s);console.log(o.escalate_reason||"")}catch(e){console.log("PARSE_ERR:"+e.message)}})')
if [ -n "$ESCALATE" ] && [ "$ESCALATE" != "PARSE_ERR" ] && echo "$ESCALATE" | grep -q "auth_failure"; then
    echo "  [PASS] normalize 后 escalate_reason 含 auth_failure"
    PASS=$((PASS + 1))
else
    echo "  [FAIL] normalize 后 escalate_reason 异常: $ESCALATE"
    echo "        NORM: $NORM"
    FAIL=$((FAIL + 1))
fi
echo ""

echo "=== Results: ${PASS} passed, ${FAIL} failed ==="
[ "$FAIL" -eq 0 ] || exit 1
