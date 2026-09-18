#!/usr/bin/env bash
# test_codex_fanout_parallel.sh — codex 模式 fanout 并行 dispatchSubAgent 测试
#
# 验证 codex 模式下 fanout 的最小契约：
#   (a) Promise.all 并行调多个 dispatchSubAgent 不抛错（每个返回 exitStatus=DONE）
#   (b) 每个 dispatch 落盘独立 codex-logs 文件
#   (c) 并行耗时小于串行耗时（验证真并发）
#
# 用 fake codex 脚本（success 模式 + sleep 0.2s 模拟 codex exec 耗时）

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR"/../../../.. && pwd)"
FAKE_CODEX_DIR="$SCRIPT_DIR/fakes"
CODEX_BACKEND="$PROJECT_ROOT/.claude/backends/codex-backend.js"

PASS=0
FAIL=0

assert() {
    local label="$1"
    local condition="$2"
    if [ "$condition" = "true" ]; then
        echo "  [PASS] $label"
        PASS=$((PASS+1))
    else
        echo "  [FAIL] $label"
        FAIL=$((FAIL+1))
    fi
}

if [ ! -x "$FAKE_CODEX_DIR/codex" ]; then
    echo "ERROR: fake codex not found at $FAKE_CODEX_DIR/codex"
    exit 1
fi

# node runner：跑 3 个并行 dispatchSubAgent，输出结构化结果
RUNNER=$(mktemp /tmp/codex-fanout-XXXXXX.mjs)
cat > "$RUNNER" <<EOF
import { CodexBackend } from '$CODEX_BACKEND';

const backend = new CodexBackend({ rulesPath: '$PROJECT_ROOT/.claude/reference/harness-rules.yaml' });
const changeName = 'codex-fanout-test';

// 并行 3 个 dispatch（fake codex success 模式，每次 sleep 0.2s）
const t0 = Date.now();
const results = await Promise.all([1, 2, 3].map(async (wiId) => {
    return await backend.dispatchSubAgent(
        'developer',
        \`实现 work item \${wiId}. 回复 JSON fenced block. 不要执行命令.\`,
        { skipBuildPrompt: true, contextMode: 'read_only', phase: 'implement', changeName, round: wiId }
    );
}));
const parallelDt = Date.now() - t0;

// 串行 3 个 dispatch（基线对比）
const t1 = Date.now();
for (const wiId of [1, 2, 3]) {
    await backend.dispatchSubAgent(
        'developer', \`redo \${wiId}\`,
        { skipBuildPrompt: true, contextMode: 'read_only', phase: 'implement', changeName: 'codex-fanout-test-serial', round: wiId }
    );
}
const serialDt = Date.now() - t1;

console.log(JSON.stringify({
    parallel_count: results.length,
    parallel_exit_statuses: results.map(r => r.exitStatus),
    parallel_elapsed_ms: parallelDt,
    serial_elapsed_ms: serialDt,
}, null, 2));
EOF

echo "=== Test (a) Promise.all 并行调 3 个 dispatchSubAgent ==="
OUTPUT=$(PATH="$FAKE_CODEX_DIR:$PATH" CODEX_HOME="$HOME/.codex" HARNESS_FAKE_CODEX_MODE=success CLAUDE_PROJECT_DIR="$PROJECT_ROOT" node --input-type=module < "$RUNNER" 2>&1 | tail -15)
echo "$OUTPUT"

COUNT=$(echo "$OUTPUT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['parallel_count'])")
assert "3 个 dispatch 都返回" "$([ "$COUNT" = "3" ] && echo true || echo false)"

EXIT_STATUSES=$(echo "$OUTPUT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(','.join(d['parallel_exit_statuses']))")
assert "全部 exitStatus=DONE" "$([ "$EXIT_STATUSES" = "DONE,DONE,DONE" ] && echo true || echo false)"

echo ""
echo "=== Test (b) 每个 dispatch 落盘独立 codex-logs 文件 ==="
LOGS_DIR="$PROJECT_ROOT/.harness/shared-state/codex-fanout-test/codex-logs"
LOG_COUNT=$(find "$LOGS_DIR" -name "developer-*.txt" 2>/dev/null | wc -l)
echo "  找到 $LOG_COUNT 份 log"
assert "至少 3 份 log（每 round 一份）" "$([ "$LOG_COUNT" -ge 3 ] && echo true || echo false)"

echo ""
echo "=== Test (c) 真并行：spawn 异步后 parallel < serial ==="
PARALLEL_MS=$(echo "$OUTPUT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['parallel_elapsed_ms'])")
SERIAL_MS=$(echo "$OUTPUT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['serial_elapsed_ms'])")
echo "  parallel=${PARALLEL_MS}ms, serial=${SERIAL_MS}ms"
# Phase 3b: spawn 异步后 Promise.all 真并行 → parallel < serial * 0.7（3 个 sleep 0.2s 并行 ~ 0.2-0.3s, 串行 ~ 0.6s）
THRESHOLD=$(python3 -c "print(int(${SERIAL_MS} * 0.7))")
assert "parallel < serial * 0.7（Phase 3b spawn 异步真并行）" "$([ "$PARALLEL_MS" -lt "$THRESHOLD" ] && echo true || echo false)"

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="

# 清理测试产物
rm -f "$RUNNER"
rm -rf "$PROJECT_ROOT/.harness/shared-state/codex-fanout-test"
rm -rf "$PROJECT_ROOT/.harness/shared-state/codex-fanout-test-serial"

[ "$FAIL" = "0" ] || exit 1
