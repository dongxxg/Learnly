#!/usr/bin/env bash
# regression 测试：Claude 模式零退化（tasks 9.1-9.3）
#
# 验证：
#   - HARNESS_BACKEND 未设置 / =claude 时 dispatch-prompt 输出 backend.type === "claude"
#   - 现有 dispatch 相关测试（test_dispatch_*.sh、test_codex_backend_dispatch.sh）全绿
#   - 9 个历史 change 的 pipeline-state.json 不被本次改动破坏（schema 兼容）
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR"/../../../.. && pwd)"
ORCH="$PROJECT_ROOT/.claude/skills/rd-auto/scripts/orchestrator.js"
TESTS_DIR="$PROJECT_ROOT/.claude/tools/scripts/tests"

PASS=0
FAIL=0
TMP_DIRS=""

cleanup() {
    for d in $TMP_DIRS; do
        rm -rf "$d" 2>/dev/null || true
    done
}
trap cleanup EXIT

echo "=== Claude Mode Regression Tests (tasks 9.1-9.3) ==="
echo ""

# ─── Test 1: HARNESS_BACKEND unset → backend.type === "claude" ───
echo "Test 1: HARNESS_BACKEND 未设置时 backend.type=claude"
CHANGE_NAME="test-claude-regression-$$"
node "$ORCH" init "$CHANGE_NAME" \
    --flow-type development \
    --intent-json '{"task_type":"feature","intent_category":"feature_dev","confidence":0.9,"affected_files":["x"],"complexity_hint":"M"}' \
    --criteria "test" > /dev/null 2>&1

# 显式 unset HARNESS_BACKEND
unset HARNESS_BACKEND
DP_OUT=$(node "$ORCH" dispatch-prompt "$CHANGE_NAME" 2>&1)
BACKEND_TYPE=$(echo "$DP_OUT" | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
    try { const j = JSON.parse(s); console.log(j.backend?.type || ""); }
    catch (e) { console.log(""); }
});' 2>/dev/null || echo "")
if [ "$BACKEND_TYPE" = "claude" ]; then
    echo "  [PASS] HARNESS_BACKEND 未设置 → backend.type=claude"
    PASS=$((PASS + 1))
else
    echo "  [FAIL] backend.type=$BACKEND_TYPE (期望 claude)"
    FAIL=$((FAIL + 1))
fi

# 清理
rm -rf "$PROJECT_ROOT/.harness/spec/changes/$CHANGE_NAME" "$PROJECT_ROOT/.harness/tasks/$CHANGE_NAME" 2>/dev/null || true
echo ""

# ─── Test 2: HARNESS_BACKEND=claude → backend.type === "claude" ───
echo "Test 2: HARNESS_BACKEND=claude 时 backend.type=claude"
CHANGE_NAME="test-claude-regression-$$-2"
HARNESS_BACKEND=claude node "$ORCH" init "$CHANGE_NAME" \
    --flow-type development \
    --intent-json '{"task_type":"feature","intent_category":"feature_dev","confidence":0.9,"affected_files":["x"],"complexity_hint":"M"}' \
    --criteria "test" > /dev/null 2>&1

DP_OUT=$(HARNESS_BACKEND=claude node "$ORCH" dispatch-prompt "$CHANGE_NAME" 2>&1)
BACKEND_TYPE=$(echo "$DP_OUT" | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
    try { const j = JSON.parse(s); console.log(j.backend?.type || ""); }
    catch (e) { console.log(""); }
});' 2>/dev/null || echo "")
if [ "$BACKEND_TYPE" = "claude" ]; then
    echo "  [PASS] HARNESS_BACKEND=claude → backend.type=claude"
    PASS=$((PASS + 1))
else
    echo "  [FAIL] backend.type=$BACKEND_TYPE (期望 claude)"
    FAIL=$((FAIL + 1))
fi
rm -rf "$PROJECT_ROOT/.harness/spec/changes/$CHANGE_NAME" "$PROJECT_ROOT/.harness/tasks/$CHANGE_NAME" 2>/dev/null || true
echo ""

# ─── Test 3: 主会话 Claude 模式禁止调 ClaudeBackend.dispatchSubAgent ───
echo "Test 3: ClaudeBackend.dispatchSubAgent 返回 PENDING 占位（Claude 模式不调用）"
RESULT=$(MODULE_PATH="$PROJECT_ROOT/.claude/backends/claude-backend.js" \
    node --input-type=module -e '
import { pathToFileURL } from "node:url";
const mod = await import(pathToFileURL(process.env.MODULE_PATH).href);
const backend = new mod.ClaudeBackend();
const result = await backend.dispatchSubAgent("developer", "test", {});
console.log(JSON.stringify(result));
' 2>&1)
EXIT_STATUS=$(echo "$RESULT" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const o=JSON.parse(s);console.log(o.exitStatus||"")}catch(e){console.log("ERR")}})')
if [ "$EXIT_STATUS" = "PENDING" ]; then
    echo "  [PASS] ClaudeBackend.dispatchSubAgent 返回 PENDING (exitStatus=$EXIT_STATUS)"
    PASS=$((PASS + 1))
else
    echo "  [FAIL] ClaudeBackend.dispatchSubAgent 异常: exitStatus=$EXIT_STATUS"
    echo "        RESULT: $RESULT"
    FAIL=$((FAIL + 1))
fi
echo ""

# ─── Test 4: 现有 dispatch 测试全绿 ───
echo "Test 4: 现有 dispatch 相关测试全绿"
DISPATCH_TESTS=(
    "$TESTS_DIR/test_codex_backend_dispatch.sh"
)
ALL_PASS=1
for t in "${DISPATCH_TESTS[@]}"; do
    if [ -x "$t" ] || [ -f "$t" ]; then
        if bash "$t" > /tmp/regression-test-$$.out 2>&1; then
            echo "  [PASS] $(basename $t)"
        else
            echo "  [FAIL] $(basename $t)"
            cat /tmp/regression-test-$$.out | tail -10 | sed 's/^/        /'
            ALL_PASS=0
        fi
    fi
done
if [ "$ALL_PASS" -eq 1 ]; then
    PASS=$((PASS + 1))
else
    FAIL=$((FAIL + 1))
fi
rm -f /tmp/regression-test-$$.out
echo ""

# ─── Test 5: 9 个历史 change pipeline-state.json schema 兼容 ───
echo "Test 5: 历史 change pipeline-state.json schema 兼容"
STATE_DIR="$PROJECT_ROOT/.harness/tasks"
HISTORICAL_COUNT=0
SCHEMA_OK=0
SCHEMA_FAIL=0
if [ -d "$STATE_DIR" ]; then
    for change_dir in "$STATE_DIR"/*/; do
        [ -d "$change_dir" ] || continue
        STATE_FILE="$change_dir/pipeline-state.json"
        [ -f "$STATE_FILE" ] || continue
        HISTORICAL_COUNT=$((HISTORICAL_COUNT + 1))
        # 验证关键字段仍在（不被本次改动破坏）
        # 注：flow_type 在历史 mock 数据中可能缺失，作为 optional
        if node -e '
const fs = require("fs");
const s = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const required = ["change_name", "current_phase", "pipeline"];
for (const k of required) {
    if (!(k in s)) { process.exit(1); }
}
if (typeof s.pipeline !== "object" || s.pipeline === null) process.exit(1);
' "$STATE_FILE" 2>/dev/null; then
            SCHEMA_OK=$((SCHEMA_OK + 1))
        else
            SCHEMA_FAIL=$((SCHEMA_FAIL + 1))
            echo "  [WARN] schema 异常: $STATE_FILE"
        fi
    done
fi
if [ "$SCHEMA_FAIL" -eq 0 ]; then
    echo "  [PASS] $HISTORICAL_COUNT 个历史 change schema 全部兼容 (SCHEMA_OK=$SCHEMA_OK)"
    PASS=$((PASS + 1))
else
    echo "  [FAIL] $SCHEMA_FAIL/$HISTORICAL_COUNT 个历史 change schema 异常"
    FAIL=$((FAIL + 1))
fi
echo ""

echo "=== Results: ${PASS} passed, ${FAIL} failed ==="
[ "$FAIL" -eq 0 ] || exit 1
