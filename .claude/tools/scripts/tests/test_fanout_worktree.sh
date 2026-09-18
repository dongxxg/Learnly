#!/usr/bin/env bash
# Test: fanout.js createWorktrees + cleanupWorktrees (Tasks 2.1, 2.2)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR"/../../../.. && pwd)"
FANOUT_MODULE="$PROJECT_ROOT/.claude/skills/rd-auto/scripts/lib/fanout.js"

PASS=0
FAIL=0

echo "=== fanout.js createWorktrees + cleanupWorktrees Tests ==="
echo ""

cd "$PROJECT_ROOT"
WORKTREE_BASE="$PROJECT_ROOT/.harness/.worktrees"
TEST_CHANGE="test-wt-$(date +%s)"

# Cleanup trap
cleanup_test() {
    for d in "$WORKTREE_BASE"/test-wt-*; do
        if [ -d "$d" ]; then
            for sub in "$d"/*; do
                if [ -d "$sub" ]; then
                    git worktree remove --force "$sub" 2>/dev/null || true
                fi
            done
        fi
    done
    rm -rf "$WORKTREE_BASE"/test-wt-* 2>/dev/null || true
    git worktree prune 2>/dev/null || true
}
trap cleanup_test EXIT
cleanup_test

# Helper: Run a node script with fanout module
# Usage: run_fanout_script "JS_CODE" [env_vars...]
run_fanout_script() {
    local js_code="$1"
    node --input-type=module -e "$js_code" 2>&1
}

# ─── Test 1: createWorktrees ───
echo "Test 1: createWorktrees creates worktrees for all agents"
RESULT=$(FANOUT_MOD="$FANOUT_MODULE" TEST_CH="$TEST_CHANGE" node --input-type=module -e '
const { pathToFileURL } = await import("node:url");
const mod = await import(pathToFileURL(process.env.FANOUT_MOD).href);
const r = mod.createWorktrees(process.env.TEST_CH, [
  { work_item_id: "WI-1", role: "developer", description: "task 1" },
  { work_item_id: "WI-2", role: "developer", description: "task 2" },
  { work_item_id: "WI-3.1", role: "reviewer", description: "review 3.1" },
]);
console.log(JSON.stringify(r));
' 2>&1)
echo "  output: $(echo "$RESULT" | head -1)"

# Parse worktree paths
WI1_PATH=$(echo "$RESULT" | tail -1 | node -e 'let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{try{const o=JSON.parse(s); const a=o.find(x=>x.work_item_id==="WI-1"); console.log(a?.worktree_path||"MISSING")}catch(e){console.log("MISSING")}})')
WI2_PATH=$(echo "$RESULT" | tail -1 | node -e 'let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{try{const o=JSON.parse(s); const a=o.find(x=>x.work_item_id==="WI-2"); console.log(a?.worktree_path||"MISSING")}catch(e){console.log("MISSING")}})')
WI3_PATH=$(echo "$RESULT" | tail -1 | node -e 'let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{try{const o=JSON.parse(s); const a=o.find(x=>x.work_item_id==="WI-3.1"); console.log(a?.worktree_path||"MISSING")}catch(e){console.log("MISSING")}})')

ALL_OK=1
for pair in "WI-1:$WI1_PATH" "WI-2:$WI2_PATH" "WI-3.1:$WI3_PATH"; do
    wi_id="${pair%%:*}"
    wi_path="${pair#*:}"
    if [ "$wi_path" = "MISSING" ] || [ -z "$wi_path" ] || [ ! -d "$wi_path" ]; then
        echo "  [debug] $wi_id: worktree missing (path=$wi_path)"
        ALL_OK=0
    fi
done

if [ "$ALL_OK" -eq 1 ]; then
    echo "  [PASS] all worktrees created"
    PASS=$((PASS + 1))
else
    echo "  [FAIL] some worktrees missing"
    FAIL=$((FAIL + 1))
fi
echo ""

# ─── Test 1b: Path format ───
echo "Test 1b: worktree path format .harness/.worktrees/<change>/<wi-id>/"
if echo "$WI1_PATH" | grep -q ".harness/.worktrees/$TEST_CHANGE/WI-1"; then
    echo "  [PASS] path format correct"
    PASS=$((PASS + 1))
else
    echo "  [FAIL] unexpected path: $WI1_PATH"
    FAIL=$((FAIL + 1))
fi
echo ""

# ─── Test 2: git worktree list ───
echo "Test 2: git worktree list includes expected worktrees"
WT_COUNT=$(git worktree list 2>/dev/null | grep -c ".worktrees/$TEST_CHANGE" || true)
if [ "$WT_COUNT" -ge 3 ]; then
    echo "  [PASS] git worktree list contains test worktrees (count=$WT_COUNT)"
    PASS=$((PASS + 1))
else
    echo "  [FAIL] expected >=3, got $WT_COUNT"
    FAIL=$((FAIL + 1))
fi
echo ""

# ─── Test 3: Artifact isolation ───
echo "Test 3: artifact isolation across worktrees"
echo "wi-1-artifact" > "$WI1_PATH/wi1_output.txt"
echo "wi-2-artifact" > "$WI2_PATH/wi2_output.txt"

if [ ! -f "$PROJECT_ROOT/wi1_output.txt" ] && [ ! -f "$PROJECT_ROOT/wi2_output.txt" ]; then
    echo "  [PASS] artifacts not leaked to main repo"
    PASS=$((PASS + 1))
else
    echo "  [FAIL] artifact leaked to main repo"
    FAIL=$((FAIL + 1))
fi
echo ""

# ─── Test 3b: Artifact independence ───
echo "Test 3b: artifact independence across worktrees"
WI1C=$(cat "$WI1_PATH/wi1_output.txt" 2>/dev/null || echo "")
WI2C=$(cat "$WI2_PATH/wi2_output.txt" 2>/dev/null || echo "")
if [ "$WI1C" = "wi-1-artifact" ] && [ "$WI2C" = "wi-2-artifact" ]; then
    echo "  [PASS] each worktree has independent content"
    PASS=$((PASS + 1))
else
    echo "  [FAIL] WI-1=$WI1C WI-2=$WI2C"
    FAIL=$((FAIL + 1))
fi
echo ""

# ─── Test 4: cleanupWorktrees ───
echo "Test 4: cleanupWorktrees removes reviewed worktrees"
CLEANUP_OUT=$(FANOUT_MOD="$FANOUT_MODULE" TEST_CH="$TEST_CHANGE" WI1P="$WI1_PATH" WI2P="$WI2_PATH" WI3P="$WI3_PATH" node --input-type=module -e '
const { pathToFileURL } = await import("node:url");
const mod = await import(pathToFileURL(process.env.FANOUT_MOD).href);
const r = mod.cleanupWorktrees(process.env.TEST_CH, [
  { id: "WI-1", status: "reviewed", worktree_path: process.env.WI1P },
  { id: "WI-2", status: "reviewed", worktree_path: process.env.WI2P },
  { id: "WI-3.1", status: "in_progress", worktree_path: process.env.WI3P },
]);
console.log(JSON.stringify(r));
' 2>&1)
echo "  cleanupWorktrees: $(echo "$CLEANUP_OUT" | tail -1)"

WT1_GONE=0; if [ ! -d "$WI1_PATH" ]; then WT1_GONE=1; fi
WT2_GONE=0; if [ ! -d "$WI2_PATH" ]; then WT2_GONE=1; fi
WT3_KEPT=0; if [ -d "$WI3_PATH" ]; then WT3_KEPT=1; fi

if [ "$WT1_GONE" -eq 1 ] && [ "$WT2_GONE" -eq 1 ] && [ "$WT3_KEPT" -eq 1 ]; then
    echo "  [PASS] reviewed removed, in_progress retained"
    PASS=$((PASS + 1))
else
    echo "  [FAIL] WI-1 gone=$WT1_GONE WI-2 gone=$WT2_GONE WI-3.1 kept=$WT3_KEPT"
    FAIL=$((FAIL + 1))
fi
echo ""

# ─── Test 4b: git worktree list after cleanup ───
echo "Test 4b: git worktree list after cleanup"
WT_AFTER=$(git worktree list 2>/dev/null | grep -c ".worktrees/$TEST_CHANGE" || true)
if [ "$WT_AFTER" -eq 1 ]; then
    echo "  [PASS] 1 worktree remaining (WI-3.1 in_progress)"
    PASS=$((PASS + 1))
else
    echo "  [FAIL] expected 1, got $WT_AFTER"
    FAIL=$((FAIL + 1))
fi
echo ""

# Cleanup remaining
git worktree remove --force "$WI3_PATH" 2>/dev/null || true
git worktree prune 2>/dev/null || true
rm -rf "$WORKTREE_BASE/$TEST_CHANGE" 2>/dev/null || true

echo "=== Results: ${PASS} passed, ${FAIL} failed ==="
[ "$FAIL" -eq 0 ] || exit 1
