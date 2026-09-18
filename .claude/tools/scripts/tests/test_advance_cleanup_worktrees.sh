#!/usr/bin/env bash
# Test: advance.js cleanupWorktrees integration (Tasks 3.1, 3.2)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR"/../../../.. && pwd)"
ADVANCE_JS="$PROJECT_ROOT/.claude/skills/rd-auto/scripts/lib/advance.js"
FANOUT_JS="$PROJECT_ROOT/.claude/skills/rd-auto/scripts/lib/fanout.js"

PASS=0
FAIL=0

echo "=== advance.js cleanupWorktrees integration Tests ==="
echo ""

cd "$PROJECT_ROOT"

# Test 1: advance.js imports cleanupWorktrees from fanout.js
echo "Test 1: advance.js imports cleanupWorktrees from fanout.js"
if grep -q "cleanupWorktrees" "$ADVANCE_JS"; then
    echo "  [PASS] cleanupWorktrees referenced in advance.js"
    PASS=$((PASS + 1))
else
    echo "  [FAIL] cleanupWorktrees NOT referenced in advance.js"
    FAIL=$((FAIL + 1))
fi
echo ""

# Test 2: teamAdvance allDone path calls cleanupWorktrees
echo "Test 2: teamAdvance allDone path calls cleanupWorktrees after integrateWorktreeArtifacts"
# Extract the allDone block from teamAdvance and check for cleanupWorktrees call
ALLDONE_BLOCK=$(sed -n '/const allDone/,/^  \/\/ Build next dispatch plan/p' "$ADVANCE_JS" 2>/dev/null || sed -n '/allDone/,/Build next dispatch plan/p' "$ADVANCE_JS" 2>/dev/null || true)
if echo "$ALLDONE_BLOCK" | grep -q "cleanupWorktrees"; then
    echo "  [PASS] cleanupWorktrees called in allDone path"
    PASS=$((PASS + 1))
else
    echo "  [FAIL] cleanupWorktrees NOT called in allDone path"
    FAIL=$((FAIL + 1))
fi
echo ""

# Test 3: cleanupWorktrees function exists in fanout.js
echo "Test 3: cleanupWorktrees function exists in fanout.js"
if grep -q "export function cleanupWorktrees" "$FANOUT_JS"; then
    echo "  [PASS] cleanupWorktrees exported from fanout.js"
    PASS=$((PASS + 1))
else
    echo "  [FAIL] cleanupWorktrees not found in fanout.js"
    FAIL=$((FAIL + 1))
fi
echo ""

# Test 4: createWorktrees function exists in fanout.js
echo "Test 4: createWorktrees function exists in fanout.js"
if grep -q "export function createWorktrees" "$FANOUT_JS"; then
    echo "  [PASS] createWorktrees exported from fanout.js"
    PASS=$((PASS + 1))
else
    echo "  [FAIL] createWorktrees not found in fanout.js"
    FAIL=$((FAIL + 1))
fi
echo ""

# Test 5: Integration — create worktrees, simulate allDone, verify cleanup
echo "Test 5: Integration — cleanupWorktrees actually removes worktree directories"
TEST_CHANGE="test-adv-int-$(date +%s)"
WT_BASE="$PROJECT_ROOT/.harness/.worktrees/$TEST_CHANGE"

cleanup_test5() {
    [ -d "$WT_BASE" ] || return 0
    for sub in "$WT_BASE"/*; do
        [ -d "$sub" ] && git worktree remove --force "$sub" 2>/dev/null || true
    done
    rm -rf "$WT_BASE" 2>/dev/null || true
    git worktree prune 2>/dev/null || true
}

# Create worktrees via the module
FANOUT_MOD="$FANOUT_JS" TEST_CH="$TEST_CHANGE" node --input-type=module -e '
const { pathToFileURL } = await import("node:url");
const mod = await import(pathToFileURL(process.env.FANOUT_MOD).href);
const agents = mod.createWorktrees(process.env.TEST_CH, [
  { work_item_id: "WI-A", role: "developer", description: "A" },
  { work_item_id: "WI-B", role: "developer", description: "B" },
]);
agents.forEach(a => console.log(a.worktree_path || "FAILED:" + (a.error||"")));
' 2>&1

# Verify worktrees exist
WI_A_PATH="$WT_BASE/WI-A"
WI_B_PATH="$WT_BASE/WI-B"
WT_BEFORE=$(git worktree list 2>/dev/null | grep -c ".worktrees/$TEST_CHANGE" || true)
echo "  Worktrees before cleanup: $WT_BEFORE"

# Call cleanupWorktrees directly
FANOUT_MOD="$FANOUT_JS" TEST_CH="$TEST_CHANGE" node --input-type=module -e '
const { pathToFileURL } = await import("node:url");
const mod = await import(pathToFileURL(process.env.FANOUT_MOD).href);
const result = mod.cleanupWorktrees(process.env.TEST_CH, [
  { id: "WI-A", status: "reviewed", worktree_path: "'"$WI_A_PATH"'" },
  { id: "WI-B", status: "reviewed", worktree_path: "'"$WI_B_PATH"'" },
]);
console.log(JSON.stringify(result));
' 2>&1

WT_AFTER=$(git worktree list 2>/dev/null | grep -c ".worktrees/$TEST_CHANGE" || true)
echo "  Worktrees after cleanup: $WT_AFTER"

if [ "$WT_BEFORE" -ge 2 ] && [ "$WT_AFTER" -eq 0 ]; then
    echo "  [PASS] integration: worktrees created and cleaned up successfully"
    PASS=$((PASS + 1))
else
    echo "  [FAIL] before=$WT_BEFORE after=$WT_AFTER"
    FAIL=$((FAIL + 1))
fi
echo ""

cleanup_test5

echo "=== Results: ${PASS} passed, ${FAIL} failed ==="
[ "$FAIL" -eq 0 ] || exit 1
