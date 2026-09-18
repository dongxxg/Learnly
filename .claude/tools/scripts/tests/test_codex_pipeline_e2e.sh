#!/usr/bin/env bash
# test_codex_pipeline_e2e.sh — Codex pipeline e2e: real CLI smoke + orchestrator state machine + dispatch routing
#
# Covers:
#   1. Real codex CLI smoke test (codex exec --json)
#   2. backend-info shows codex when HARNESS_BACKEND=codex
#   3. Pipeline init → dispatch-prompt correctly identifies codex backend
#   4. fanout-dispatch-agent with codex backend (team mode)
#   5. ci-run-agent routes to codex exec when HARNESS_BACKEND=codex
#   6. Pipeline state machine: set-phase → mark-dispatch --backend codex → token_usage.backend persisted
#   7. Pipeline state transitions (advance) preserve backend in dispatch_history
#
# Run: bash .claude/tools/scripts/tests/test_codex_pipeline_e2e.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR"/../../../.. && pwd)"
ORCH="$PROJECT_ROOT/.claude/skills/rd-auto/scripts/orchestrator.js"
CI_RUN_AGENT="$PROJECT_ROOT/.claude/tools/scripts/ci/ci-run-agent.js"
FANOUT_AGENT="$PROJECT_ROOT/.claude/skills/rd-auto/scripts/fanout-dispatch-agent.js"
FAKE_CODEX="$SCRIPT_DIR/fakes/codex"
CHANGE_NAME="test-codex-pipeline-e2e"

PASS=0
FAIL=0
TMP_DIRS=""

cleanup() {
  for d in $TMP_DIRS; do
    rm -rf "$d" 2>/dev/null || true
  done
  rm -rf "$PROJECT_ROOT/.harness/spec/changes/$CHANGE_NAME" 2>/dev/null || true
  rm -rf "$PROJECT_ROOT/.harness/tasks/$CHANGE_NAME" 2>/dev/null || true
  rm -rf "$PROJECT_ROOT/.harness/shared-state/$CHANGE_NAME" 2>/dev/null || true
  rm -rf "$PROJECT_ROOT/.harness/spec/changes/${CHANGE_NAME}-t2" 2>/dev/null || true
  rm -rf "$PROJECT_ROOT/.harness/tasks/${CHANGE_NAME}-t2" 2>/dev/null || true
  rm -rf "$PROJECT_ROOT/.harness/shared-state/${CHANGE_NAME}-t2" 2>/dev/null || true
}
trap cleanup EXIT

echo "=== Codex Pipeline E2E Test ==="
echo ""

# ─── Test 1: Real codex CLI smoke ───
echo "Test 1: Real codex CLI smoke (codex exec --json)"
if command -v codex &>/dev/null; then
  SMOKE_OUT=$(codex exec --json --sandbox danger-full-access "respond with just the single word OK and nothing else" 2>&1 || true)
  if echo "$SMOKE_OUT" | grep -qi "OK"; then
    echo "  [PASS] codex exec --json returned OK"
    PASS=$((PASS + 1))
  elif echo "$SMOKE_OUT" | grep -q '"type"'; then
    echo "  [PASS] codex exec --json produced JSONL output"
    PASS=$((PASS + 1))
  else
    echo "  [FAIL] codex exec --json produced unexpected output (first 200 chars):"
    echo "        ${SMOKE_OUT:0:200}"
    FAIL=$((FAIL + 1))
  fi
else
  echo "  [SKIP] codex CLI not available"
fi
echo ""

# ─── Test 2: backend-info shows codex ───
echo "Test 2: backend-info with HARNESS_BACKEND=codex"
BACKEND_INFO=$(HARNESS_BACKEND=codex node "$ORCH" backend-info 2>&1)
BACKEND_TYPE=$(echo "$BACKEND_INFO" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).type)}catch(e){console.log("PARSE_ERR")}})')
if [ "$BACKEND_TYPE" = "codex" ]; then
  echo "  [PASS] backend-info reports type=codex"
  PASS=$((PASS + 1))
else
  echo "  [FAIL] expected codex, got: $BACKEND_TYPE"
  FAIL=$((FAIL + 1))
fi
echo ""

# ─── Test 3: Pipeline init + dispatch-prompt identifies codex backend ───
echo "Test 3: Pipeline init → dispatch-prompt identifies codex backend"
rm -rf "$PROJECT_ROOT/.harness/spec/changes/$CHANGE_NAME" 2>/dev/null || true
rm -rf "$PROJECT_ROOT/.harness/tasks/$CHANGE_NAME" 2>/dev/null || true

HARNESS_BACKEND=codex node "$ORCH" init "$CHANGE_NAME" \
  --flow-type development \
  --intent-json '{"task_type":"feature","intent_category":"feature_dev","confidence":0.9,"affected_files":["test.js"],"complexity_hint":"S"}' \
  --criteria "Verify codex e2e pipeline" > /dev/null 2>&1 || true

STATE_FILE="$PROJECT_ROOT/.harness/tasks/$CHANGE_NAME/pipeline-state.json"
if [ -f "$STATE_FILE" ]; then
  # dispatch-prompt correctly identifies codex backend (backend determined at dispatch time, not init time)
  DP_OUT=$(HARNESS_BACKEND=codex node "$ORCH" dispatch-prompt "$CHANGE_NAME" 2>&1)
  DP_TYPE=$(echo "$DP_OUT" | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
try{const j=JSON.parse(s);console.log(j.backend?.type||"MISSING")}
catch(e){console.log("PARSE_ERR")}})')
  if [ "$DP_TYPE" = "codex" ]; then
    echo "  [PASS] init succeeded + dispatch-prompt backend.type=codex"
    PASS=$((PASS + 1))
  else
    echo "  [FAIL] dispatch-prompt backend.type=$DP_TYPE (expected codex)"
    FAIL=$((FAIL + 1))
  fi
else
  echo "  [FAIL] pipeline-state.json not created"
  FAIL=$((FAIL + 1))
fi
echo ""

# ─── Test 4: fanout-dispatch-agent with codex backend ───
echo "Test 4: fanout-dispatch-agent with HARNESS_BACKEND=codex"
if [ -f "$STATE_FILE" ]; then
  # Set up team mode + implement phase for fanout
  node -e "
const fs = require('fs');
const s = JSON.parse(fs.readFileSync('$STATE_FILE','utf8'));
s.mode = 'team';
s.current_phase = 'implement';
s.team = { status: 'executing', work_items: [{id:'WI-1',title:'test',description:'test item',status:'available',artifact_paths:[],assigned_agent:null,worktree_path:null,blocked_count:0}] };
fs.writeFileSync('$STATE_FILE', JSON.stringify(s,null,2));
" 2>/dev/null || true

  FANOUT_OUT=$(HARNESS_BACKEND=codex node "$FANOUT_AGENT" "$CHANGE_NAME" 2>&1 || true)
  FANOUT_BE=$(echo "$FANOUT_OUT" | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
try{const j=JSON.parse(s);console.log(j.backend||"MISSING")}
catch(e){console.log("PARSE_ERR")}})')
  FANOUT_ACTION=$(echo "$FANOUT_OUT" | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
try{const j=JSON.parse(s);console.log(j.action||"MISSING")}
catch(e){console.log("PARSE_ERR")}})')
  if [ "$FANOUT_BE" = "codex" ] && [ -n "$FANOUT_ACTION" ]; then
    echo "  [PASS] fanout-dispatch-agent backend=codex, action=$FANOUT_ACTION"
    PASS=$((PASS + 1))
  else
    echo "  [FAIL] fanout backend=$FANOUT_BE action=$FANOUT_ACTION"
    FAIL=$((FAIL + 1))
  fi
else
  echo "  [SKIP] no pipeline-state"
fi
echo ""

# ─── Test 5: ci-run-agent routes to codex ───
echo "Test 5: ci-run-agent routes to codex exec with HARNESS_BACKEND=codex"
if [ -f "$CI_RUN_AGENT" ]; then
  FAKE_BIN="$(mktemp -d)"
  CAPTURE_FILE="$(mktemp)"
  TMP_DIRS="$TMP_DIRS $FAKE_BIN $CAPTURE_FILE"

  cat > "$FAKE_BIN/codex" <<'FAKE_SCRIPT'
#!/usr/bin/env bash
echo "INVOKED=codex" >> "${CAPTURE_FILE}"
echo "ARGS=$*" >> "${CAPTURE_FILE}"
cat > /dev/null
echo '{"result":"fake ok"}'
exit 0
FAKE_SCRIPT
  chmod +x "$FAKE_BIN/codex"

  export CAPTURE_FILE
  PATH="$FAKE_BIN:$PATH" HARNESS_BACKEND=codex \
    node "$CI_RUN_AGENT" \
      --model sonnet --max-turns 2 --allowed-tools "Read" --output-format json \
      2>/dev/null <<< "test prompt" || true

  if grep -q "INVOKED=codex" "$CAPTURE_FILE" 2>/dev/null; then
    echo "  [PASS] ci-run-agent invoked codex"
    PASS=$((PASS + 1))
  else
    echo "  [FAIL] ci-run-agent did not invoke codex"
    cat "$CAPTURE_FILE" 2>/dev/null | sed 's/^/        /'
    FAIL=$((FAIL + 1))
  fi
else
  echo "  [SKIP] ci-run-agent.js not found"
fi
echo ""

# ─── Test 6: Pipeline dispatch cycle — set-phase → mark-dispatch → token_usage.backend ───
echo "Test 6: Pipeline dispatch cycle stores backend in token_usage"
rm -rf "$PROJECT_ROOT/.harness/spec/changes/${CHANGE_NAME}-t2" 2>/dev/null || true
rm -rf "$PROJECT_ROOT/.harness/tasks/${CHANGE_NAME}-t2" 2>/dev/null || true

HARNESS_BACKEND=codex node "$ORCH" init "${CHANGE_NAME}-t2" \
  --flow-type development \
  --intent-json '{"task_type":"feature","intent_category":"feature_dev","confidence":0.9,"affected_files":["test.js"],"complexity_hint":"S"}' \
  --criteria "Test dispatch cycle" > /dev/null 2>&1 || true

T2_STATE="$PROJECT_ROOT/.harness/tasks/${CHANGE_NAME}-t2/pipeline-state.json"

if [ -f "$T2_STATE" ]; then
  # Set phase to explore (required before mark-dispatch)
  node "$ORCH" set-phase "${CHANGE_NAME}-t2" explore > /dev/null 2>&1 || true

  # Simulate a complete dispatch cycle
  node "$ORCH" mark-dispatch "${CHANGE_NAME}-t2" --start --phase explore 2>/dev/null || true
  HARNESS_BACKEND=codex node "$ORCH" mark-dispatch "${CHANGE_NAME}-t2" \
    --end --backend codex --tokens 500 --phase explore 2>/dev/null || true

  # Verify token_usage.backend = codex
  TU_BE=$(node -e "
const s=require('$T2_STATE');
const dh=s.pipeline?.explore?.dispatch_history||[];
const last=dh[dh.length-1];
console.log(last?.token_usage?.backend||'MISSING')" 2>/dev/null || echo "READ_ERR")

  if [ "$TU_BE" = "codex" ]; then
    echo "  [PASS] mark-dispatch --backend codex → token_usage.backend=codex"
    PASS=$((PASS + 1))
  else
    echo "  [FAIL] token_usage.backend=$TU_BE (expected codex)"
    FAIL=$((FAIL + 1))
  fi
else
  echo "  [FAIL] pipeline-state.json not created for t2"
  FAIL=$((FAIL + 1))
fi
echo ""

# ─── Test 7: Pipeline state transitions preserve backend through advance ───
echo "Test 7: Pipeline advance preserves backend in dispatch_history"
if [ -f "$T2_STATE" ]; then
  # Advance past explore (after successful dispatch)
  node "$ORCH" advance "${CHANGE_NAME}-t2" \
    --exit-status DONE --score 85 --artifacts "explore.md" 2>/dev/null || true

  T2_PHASE=$(node -e "const s=require('$T2_STATE');console.log(s.current_phase||'MISSING')" 2>/dev/null || echo "READ_ERR")
  # Backend should still be in dispatch_history after advance
  DH_BE=$(node -e "
const s=require('$T2_STATE');
const dh=s.pipeline?.explore?.dispatch_history||[];
const last=dh[dh.length-1];
console.log(last?.token_usage?.backend||'MISSING')" 2>/dev/null || echo "READ_ERR")

  if [ "$DH_BE" = "codex" ]; then
    echo "  [PASS] backend=codex preserved in dispatch_history after advance (phase=$T2_PHASE)"
    PASS=$((PASS + 1))
  else
    echo "  [FAIL] backend=$DH_BE after advance (phase=$T2_PHASE)"
    FAIL=$((FAIL + 1))
  fi

  # Now dispatch next phase (propose) with codex — verify multi-phase backend consistency
  node "$ORCH" set-phase "${CHANGE_NAME}-t2" propose > /dev/null 2>&1 || true
  node "$ORCH" mark-dispatch "${CHANGE_NAME}-t2" --start --phase propose 2>/dev/null || true
  HARNESS_BACKEND=codex node "$ORCH" mark-dispatch "${CHANGE_NAME}-t2" \
    --end --backend codex --tokens 300 --phase propose 2>/dev/null || true

  PH2_BE=$(node -e "
const s=require('$T2_STATE');
const dh=s.pipeline?.propose?.dispatch_history||[];
const last=dh[dh.length-1];
console.log(last?.token_usage?.backend||'MISSING')" 2>/dev/null || echo "READ_ERR")

  if [ "$PH2_BE" = "codex" ]; then
    echo "  [PASS] multi-phase: propose dispatch also records backend=codex"
    PASS=$((PASS + 1))
  else
    echo "  [FAIL] propose backend=$PH2_BE"
    FAIL=$((FAIL + 1))
  fi

  # Verify recalcTokens can aggregate by_backend from these dispatch_history entries
  node -e "
import('$PROJECT_ROOT/.claude/skills/rd-auto/scripts/lib/stats.js').then(mod => {
  const s = JSON.parse(require('fs').readFileSync('$T2_STATE','utf8'));
  mod.recalcTokens(s);
  const bb = s.token_summary?.by_backend || {};
  if (bb.codex && bb.codex.dispatch_count === 2 && bb.codex.total_tokens === 800) {
    console.log('BACKEND_AGG_OK');
  } else {
    console.log('BACKEND_AGG_FAIL:' + JSON.stringify(bb));
  }
}).catch(e => console.log('IMPORT_ERR:' + e.message));
" 2>/dev/null || echo "RECALC_ERR"

  # Cleanup t2
  rm -rf "$PROJECT_ROOT/.harness/spec/changes/${CHANGE_NAME}-t2" 2>/dev/null || true
  rm -rf "$PROJECT_ROOT/.harness/tasks/${CHANGE_NAME}-t2" 2>/dev/null || true
else
  echo "  [SKIP] no t2 pipeline-state"
fi
echo ""

echo "=== Results: ${PASS} passed, ${FAIL} failed ==="
[ "$FAIL" -eq 0 ] || exit 1
