#!/usr/bin/env bash
# test_fanout_claude_path.sh — 测试 fanout-dispatch-agent Claude 后端路径
#
# 覆盖：
#   1) Claude 后端输出 invoke_fanout_agents action（非 fanout_completed）
#   2) 每个 agent 含 prompt + subagent_type 字段
#   3) Claude 路径不导入 codex-backend（不触发 MODULE_NOT_FOUND）
#
# 注意：需要 team mode + implement phase 的 pipeline-state，因此本测试
#       拼接一个最小 state 并在 PROJECT_ROOT 临时替换。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR"/../../../.. && pwd)"
FANOUT_SCRIPT="$PROJECT_ROOT/.claude/skills/rd-auto/scripts/fanout-dispatch-agent.js"

PASS=0
FAIL=0
CLEANUP_DIRS=""

cleanup() {
  for d in ${CLEANUP_DIRS}; do
    rm -rf "${d}"
  done
}
trap cleanup EXIT

if [ ! -f "${FANOUT_SCRIPT}" ]; then
  echo "SKIP: fanout-dispatch-agent.js not found at ${FANOUT_SCRIPT}"
  exit 0
fi

echo "=== fanout-dispatch-agent Claude Backend Path Test ==="
echo ""

# ─── Setup: create a minimal team-mode pipeline-state ───
CHANGE_NAME="test-fanout-claude-$$"
TASKS_DIR="${PROJECT_ROOT}/.harness/tasks/${CHANGE_NAME}"
CHANGE_DIR="${PROJECT_ROOT}/.harness/spec/changes/${CHANGE_NAME}"
CLEANUP_DIRS="${TASKS_DIR} ${CHANGE_DIR}"

mkdir -p "${TASKS_DIR}" "${CHANGE_DIR}"

# Create tasks.md with 2 work items
cat > "${CHANGE_DIR}/tasks.md" <<'TASKS'
## 1 task one
- [ ] first task description
## 2 task two
- [ ] second task description
TASKS

# Create minimal pipeline-state.json (team mode, implement phase)
cat > "${TASKS_DIR}/pipeline-state.json" <<STATE
{
  "schema_version": 6,
  "change_name": "${CHANGE_NAME}",
  "mode": "team",
  "current_phase": "implement",
  "phases": {
    "implement": "in_progress"
  },
  "intent": {
    "task_type": "test feature"
  },
  "team": {
    "status": "executing",
    "work_items": []
  }
}
STATE

# ─── Test 1: Claude backend → invoke_fanout_agents ───
echo "Test 1: Claude backend outputs invoke_fanout_agents action"

OUTPUT=$(CLAUDE_CODE_SESSION_ID=test-session \
  node "${FANOUT_SCRIPT}" "${CHANGE_NAME}" 2>/dev/null || true)

ACTION=$(echo "${OUTPUT}" | jq -r '.action // "no_action"' 2>/dev/null || echo "parse_error")

if [ "${ACTION}" = "invoke_fanout_agents" ]; then
  echo "  [PASS] action=invoke_fanout_agents"
  PASS=$((PASS + 1))
else
  echo "  [FAIL] expected invoke_fanout_agents, got: ${ACTION}"
  echo "  Output: ${OUTPUT}"
  FAIL=$((FAIL + 1))
fi

# ─── Test 2: agents array contains prompt and subagent_type ───
echo "Test 2: agents have prompt and subagent_type fields"

AGENT_COUNT=$(echo "${OUTPUT}" | jq '.agents | length' 2>/dev/null || echo "0")
FIRST_PROMPT=$(echo "${OUTPUT}" | jq -r '.agents[0].prompt // "missing"' 2>/dev/null || echo "parse_error")
FIRST_TYPE=$(echo "${OUTPUT}" | jq -r '.agents[0].subagent_type // "missing"' 2>/dev/null || echo "parse_error")

if [ "${AGENT_COUNT}" -gt 0 ] 2>/dev/null; then
  echo "  [PASS] agent count=${AGENT_COUNT}"
  PASS=$((PASS + 1))
else
  echo "  [FAIL] no agents in output"
  FAIL=$((FAIL + 1))
fi

if [ "${FIRST_PROMPT}" != "missing" ] && [ -n "${FIRST_PROMPT}" ]; then
  echo "  [PASS] agent has prompt"
  PASS=$((PASS + 1))
else
  echo "  [FAIL] agent prompt missing"
  FAIL=$((FAIL + 1))
fi

if [ "${FIRST_TYPE}" != "missing" ]; then
  echo "  [PASS] agent has subagent_type=${FIRST_TYPE}"
  PASS=$((PASS + 1))
else
  echo "  [FAIL] agent subagent_type missing"
  FAIL=$((FAIL + 1))
fi

# ─── Test 3: Claude path skips codex import ───
echo "Test 3: Claude path does not fail on missing codex-backend"
if [ "${ACTION}" = "invoke_fanout_agents" ]; then
  echo "  [PASS] Claude path completed without codex import errors"
  PASS=$((PASS + 1))
else
  echo "  [FAIL] unexpected action: ${ACTION}"
  FAIL=$((FAIL + 1))
fi

# ─── Test 4: backend field is "claude" ───
echo "Test 4: backend field is 'claude'"
BACKEND=$(echo "${OUTPUT}" | jq -r '.backend // "unknown"' 2>/dev/null || echo "parse_error")

if [ "${BACKEND}" = "claude" ]; then
  echo "  [PASS] backend=claude"
  PASS=$((PASS + 1))
else
  echo "  [FAIL] expected backend=claude, got: ${BACKEND}"
  FAIL=$((FAIL + 1))
fi

# ─── Test 5: wrapper_invoked=true ───
echo "Test 5: wrapper_invoked=true"
WRAPPER=$(echo "${OUTPUT}" | jq -r '.wrapper_invoked // false' 2>/dev/null || echo "false")

if [ "${WRAPPER}" = "true" ]; then
  echo "  [PASS] wrapper_invoked=true"
  PASS=$((PASS + 1))
else
  echo "  [FAIL] wrapper_invoked=${WRAPPER}"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "=== Results: ${PASS} passed, ${FAIL} failed ==="

if [ "${FAIL}" -gt 0 ]; then
  exit 1
fi
exit 0
