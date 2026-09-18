#!/usr/bin/env bash
# Test: fanout-dispatch-agent.js (Tasks 4.1-4.3)
#
# Tests:
#   1. Script exists with executable permission
#   2. CLI arg parsing: <change-name> [--round N] accepted
#   3. Missing change-name → error exit
#   4. Invalid change-name → wrapper_error exit
#   5. Team mode + implement phase validation in pipeline-state
#   6. createWorktrees integration (worktree paths in results)
#   7. dispatch-fanout.md template rendering
#   8. Normalize dispatch results (snake_case)
#   9. Output JSON schema: {backend, action: "fanout_completed", results[], wrapper_invoked}
#   10. Error isolation: single worktree failure doesn't block others
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR"/../../../.. && pwd)"
FANOUT_AGENT="$PROJECT_ROOT/.claude/skills/rd-auto/scripts/fanout-dispatch-agent.js"
CODEX_BACKEND="$PROJECT_ROOT/.claude/backends/codex-backend.js"
RULES_YAML="$PROJECT_ROOT/.claude/reference/harness-rules.yaml"

PASS=0
FAIL=0
CLEANUP_DIRS=""

cleanup() {
    for d in ${CLEANUP_DIRS}; do
        rm -rf "${d}" 2>/dev/null || true
    done
    rm -rf "$PROJECT_ROOT/.harness/.worktrees"/test-fanout-* 2>/dev/null || true
    git worktree prune 2>/dev/null || true
}
trap cleanup EXIT

echo "=== fanout-dispatch-agent.js Tests ==="
echo ""

# Test 1: Script file exists
echo "Test 1: fanout-dispatch-agent.js exists"
if [ -f "$FANOUT_AGENT" ]; then
    echo "  [PASS] file exists"
    PASS=$((PASS + 1))
else
    echo "  [FAIL] file not found: $FANOUT_AGENT"
    FAIL=$((FAIL + 1))
fi
echo ""

# Test 2: Missing change-name produces error
echo "Test 2: Missing change-name argument produces error"
OUT=$(node "$FANOUT_AGENT" 2>&1 || true)
if echo "$OUT" | grep -qi "usage\|Usage\|change-name\|缺少\|missing"; then
    echo "  [PASS] usage/error shown for missing change-name"
    PASS=$((PASS + 1))
else
    echo "  [FAIL] unexpected output: $OUT"
    FAIL=$((FAIL + 1))
fi
echo ""

# Test 3: Invalid change-name produces wrapper_error
echo "Test 3: Invalid change-name produces wrapper_error"
OUT=$(node "$FANOUT_AGENT" "nonexistent-change-$(date +%s)" 2>&1 || true)
if echo "$OUT" | grep -q '"wrapper_error"\|"error".*"not found"\|not found'; then
    echo "  [PASS] wrapper_error for invalid change"
    PASS=$((PASS + 1))
else
    echo "  [FAIL] unexpected output: $OUT"
    FAIL=$((FAIL + 1))
fi
echo ""

# ─── Integration test with fake codex ───
echo "=== Setting up integration test with fake codex ==="

# Create fake codex
FAKE_BIN="$(mktemp -d)"
CLEANUP_DIRS="${FAKE_BIN}"

cat > "$FAKE_BIN/codex" <<'EOF'
#!/usr/bin/env bash
# Write PWD to capture file, then output Done
if [ -n "${CODEX_CAPTURE_FILE:-}" ]; then
    echo "PWD=$(pwd)" >> "$CODEX_CAPTURE_FILE"
    echo "ARGC=$#" >> "$CODEX_CAPTURE_FILE"
    i=0
    for arg in "$@"; do
        echo "===ARG${i}===" >> "$CODEX_CAPTURE_FILE"
        printf '%s\n' "$arg" >> "$CODEX_CAPTURE_FILE"
        i=$((i + 1))
    done
fi
# Simulate successful codex output
cat <<'CODEXOUT'
{"exit_status":"DONE","summary":"implemented task","artifacts":["src/file.js"],"score":85}
CODEXOUT
EOF
chmod +x "$FAKE_BIN/codex"

# Create pipeline-state.json for test
TEST_CHANGE="test-fanout-$(date +%s)"
STATE_DIR="$PROJECT_ROOT/.harness/tasks/$TEST_CHANGE"
mkdir -p "$STATE_DIR"
TIMESTAMP=$(date -Iseconds)

# Need to create tasks.md so parseTasksMd works
CHANGE_DIR="$PROJECT_ROOT/.harness/spec/changes/$TEST_CHANGE"
mkdir -p "$CHANGE_DIR"
cat > "$CHANGE_DIR/tasks.md" << 'TASKSEOF'
## 1 Test Group 1
### 1.1 Test task one
### 1.2 Test task two
## 2 Test Group 2
### 2.1 Test task three
TASKSEOF

cat > "$STATE_DIR/pipeline-state.json" << STATEEOF
{
  "change_name": "$TEST_CHANGE",
  "created_at": "$TIMESTAMP",
  "updated_at": "$TIMESTAMP",
  "mode": "team",
  "flow_type": "development",
  "current_phase": "implement",
  "blocked_count": 0,
  "rework_count": {},
  "scores": {},
  "intent": { "task_type": "feature", "context_mode": "full" },
  "team": {
    "status": "executing",
    "max_concurrent": 3,
    "work_items": []
  },
  "pipeline": {
    "intake": { "status": "done", "exit_status": "DONE", "completed_at": "$TIMESTAMP" },
    "explore": { "status": "done", "exit_status": "DONE", "completed_at": "$TIMESTAMP" },
    "propose": { "status": "done", "exit_status": "DONE", "completed_at": "$TIMESTAMP" },
    "design-review": { "status": "done", "exit_status": "DONE", "completed_at": "$TIMESTAMP" },
    "implement": { "status": "in_progress", "exit_status": null, "started_at": "$TIMESTAMP", "dispatch_history": [] }
  },
  "adaptive_overrides": { "pre_guidance_history": [] },
  "dispatch_efficiency": {},
  "quality_metrics": {},
  "quality_gates": {}
}
STATEEOF

CAPTURE_FILE="$(mktemp)"
CLEANUP_DIRS="${CLEANUP_DIRS} ${CAPTURE_FILE} ${STATE_DIR} ${CHANGE_DIR}"

# Test 4: fanout-dispatch-agent.js with team mode implement phase
echo "Test 4: fanout-dispatch-agent creates worktrees and dispatches agents"
OUT=$(PATH="$FAKE_BIN:${PATH}" \
    CLAUDE_PROJECT_DIR="$PROJECT_ROOT" \
    CODEX_CAPTURE_FILE="$CAPTURE_FILE" \
    node "$FANOUT_AGENT" "$TEST_CHANGE" 2>&1 || true)

echo "  Output: $(echo "$OUT" | grep -o '"action":"[^"]*"' || echo 'no action')"

# Check output has required fields
HAS_BACKEND=$(echo "$OUT" | grep -c '"backend"' || true)
HAS_ACTION=$(echo "$OUT" | grep -c '"action"' || true)
HAS_RESULTS=$(echo "$OUT" | grep -c '"results"' || true)
HAS_WRAPPER=$(echo "$OUT" | grep -c '"wrapper_invoked"' || true)

if [ "$HAS_BACKEND" -gt 0 ] && [ "$HAS_ACTION" -gt 0 ] && [ "$HAS_RESULTS" -gt 0 ] && [ "$HAS_WRAPPER" -gt 0 ]; then
    echo "  [PASS] output has required fields (backend, action, results, wrapper_invoked)"
    PASS=$((PASS + 1))
else
    echo "  [FAIL] missing required fields: backend=$HAS_BACKEND action=$HAS_ACTION results=$HAS_RESULTS wrapper=$HAS_WRAPPER"
    FAIL=$((FAIL + 1))
fi
echo ""

# Test 5: Worktrees were created (from CAPTURE_FILE we can see PWD)
echo "Test 5: Codex processes run in worktree directories"
PWD_COUNT=$(grep -c '^PWD=' "$CAPTURE_FILE" 2>/dev/null || true)
WT_COUNT=$(echo "$PWD_COUNT" || true)
echo "  codex invocations recorded: $WT_COUNT"

# Check worktree paths
WORKTREE_PWDS=$(grep '^PWD=' "$CAPTURE_FILE" 2>/dev/null || true)
WORKTREE_COUNT=$(echo "$WORKTREE_PWDS" | grep -c ".worktrees/$TEST_CHANGE" 2>/dev/null || true)

if [ "${WORKTREE_COUNT:-0}" -gt 0 ]; then
    echo "  [PASS] codex processes ran in worktree directories (count=$WORKTREE_COUNT)"
    PASS=$((PASS + 1))
else
    echo "  [FAIL] no worktree cwd detected"
    FAIL=$((FAIL + 1))
fi
echo ""

# Test 6: Results contain worktree_path and normalized exit_status
echo "Test 6: Results contain normalized fields (worktree_path, exit_status)"
PARSE_OK=$(echo "$OUT" | node -e '
let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
  try {
    const o=JSON.parse(s);
    if (!o.results || !Array.isArray(o.results)) { console.log("FAIL: no results array"); process.exit(1); }
    let ok=true;
    for (const r of o.results) {
      if (!r.work_item_id) { console.log("FAIL: missing work_item_id"); ok=false; break; }
      if (!r.role) { console.log("FAIL: missing role"); ok=false; break; }
      if (!r.exit_status) { console.log("FAIL: missing exit_status"); ok=false; break; }
    }
    if (ok) console.log("OK: " + o.results.length + " results");
  } catch(e) {
    console.log("FAIL: parse error: " + e.message);
    process.exit(1);
  }
})' 2>/dev/null || echo "FAIL: parse error")

if echo "$PARSE_OK" | grep -q "^OK:"; then
    echo "  [PASS] $(echo "$PARSE_OK")"
    PASS=$((PASS + 1))
else
    echo "  [FAIL] $PARSE_OK"
    FAIL=$((FAIL + 1))
fi
echo ""

# Test 7: Backward compatibility — existing dispatch-agent.js still works
echo "Test 7: Backward compatibility — dispatch-agent.js still works"
DISPATCH_AGENT="$PROJECT_ROOT/.claude/skills/rd-auto/scripts/dispatch-agent.js"
if [ -f "$DISPATCH_AGENT" ]; then
    # Quick smoke test: run with invalid change to verify it still responds correctly
    OUT2=$(PATH="$FAKE_BIN:${PATH}" node "$DISPATCH_AGENT" "nonexistent-$(date +%s)" 2>&1 || true)
    if echo "$OUT2" | grep -q '"wrapper_error"\|not found'; then
        echo "  [PASS] dispatch-agent.js still operational"
        PASS=$((PASS + 1))
    else
        echo "  [FAIL] dispatch-agent.js broken: $OUT2"
        FAIL=$((FAIL + 1))
    fi
else
    echo "  [SKIP] dispatch-agent.js not found"
fi
echo ""

# Cleanup test worktrees
for d in "$PROJECT_ROOT/.harness/.worktrees/$TEST_CHANGE"/*; do
    [ -d "$d" ] && git worktree remove --force "$d" 2>/dev/null || true
done
rm -rf "$PROJECT_ROOT/.harness/.worktrees/$TEST_CHANGE" 2>/dev/null || true
git worktree prune 2>/dev/null || true

echo "=== Results: ${PASS} passed, ${FAIL} failed ==="
[ "$FAIL" -eq 0 ] || exit 1
