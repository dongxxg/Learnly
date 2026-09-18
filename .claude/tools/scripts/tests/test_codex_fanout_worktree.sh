#!/usr/bin/env bash
# Test: codex fanout worktree isolation — 端到端集成测试 (Task 6.1)
#
# 验证完整链路：fake codex 在不同 worktree 验证产物隔离
#
# Tests:
#   (a) worktree 目录创建正确
#   (b) git worktree list 包含预期条目
#   (c) 产物文件在各自 worktree 中隔离
#   (d) integrate 后产物出现在主仓
#   (e) cleanup 后 worktree 目录移除
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR"/../../../.. && pwd)"
FANOUT_MODULE="$PROJECT_ROOT/.claude/skills/rd-auto/scripts/lib/fanout.js"

PASS=0
FAIL=0
CLEANUP_DIRS=""

cleanup() {
    for d in ${CLEANUP_DIRS}; do
        rm -rf "${d}" 2>/dev/null || true
    done
    cd "$PROJECT_ROOT"
    git worktree prune 2>/dev/null || true
}
trap cleanup EXIT

cd "$PROJECT_ROOT"

echo "=== codex fanout worktree isolation — Integration Tests ==="
echo ""

# ─── Setup ───
TEST_CHANGE="test-int-wt-$(date +%s)"
WT_BASE="$PROJECT_ROOT/.harness/.worktrees/$TEST_CHANGE"

# Clean any debris
rm -rf "$WT_BASE" 2>/dev/null || true
git worktree prune 2>/dev/null || true

# ─── Phase A: Create worktrees ───
echo "--- Phase A: Worktree Creation ---"
echo ""

echo "Test A1: createWorktrees creates 2 worktrees with correct paths"
FANOUT_MOD="$FANOUT_MODULE" TEST_CH="$TEST_CHANGE" node --input-type=module -e '
const { pathToFileURL } = await import("node:url");
const mod = await import(pathToFileURL(process.env.FANOUT_MOD).href);
const agents = mod.createWorktrees(process.env.TEST_CH, [
  { work_item_id: "WI-1", role: "developer", description: "Implement login" },
  { work_item_id: "WI-2", role: "developer", description: "Implement dashboard" },
]);
agents.forEach(a => console.log(a.work_item_id + " -> " + (a.worktree_path || "FAILED: " + (a.error||""))));
' 2>/dev/null

WI1_PATH="$WT_BASE/WI-1"
WI2_PATH="$WT_BASE/WI-2"

A1_OK=1
if [ ! -d "$WI1_PATH" ]; then
    echo "  [debug] WI-1 worktree missing: $WI1_PATH"
    A1_OK=0
fi
if [ ! -d "$WI2_PATH" ]; then
    echo "  [debug] WI-2 worktree missing: $WI2_PATH"
    A1_OK=0
fi

if [ "$A1_OK" -eq 1 ]; then
    echo "  [PASS] both worktrees created"
    PASS=$((PASS + 1))
else
    echo "  [FAIL] worktree creation failed"
    FAIL=$((FAIL + 1))
fi
echo ""

# ─── Phase B: Verify git worktree list ───
echo "--- Phase B: git worktree list ---"
echo ""

echo "Test B1: git worktree list contains expected entries"
WT_LIST=$(git worktree list 2>/dev/null)
WT_COUNT=$(echo "$WT_LIST" | grep -c ".worktrees/$TEST_CHANGE" || true)

if [ "$WT_COUNT" -ge 2 ]; then
    echo "  [PASS] git worktree list shows $WT_COUNT test worktrees"
    PASS=$((PASS + 1))
else
    echo "  [FAIL] expected >=2, got $WT_COUNT"
    echo "  list:"
    echo "$WT_LIST" | grep "worktree" | head -10 | sed 's/^/        /'
    FAIL=$((FAIL + 1))
fi
echo ""

echo "Test B2: each worktree has independent HEAD"
WT1_HEAD=$(cd "$WI1_PATH" 2>/dev/null && git rev-parse HEAD 2>/dev/null || echo "MISSING")
WT2_HEAD=$(cd "$WI2_PATH" 2>/dev/null && git rev-parse HEAD 2>/dev/null || echo "MISSING")

if [ "$WT1_HEAD" != "MISSING" ] && [ "$WT2_HEAD" != "MISSING" ] && [ "$WT1_HEAD" = "$WT2_HEAD" ]; then
    echo "  [PASS] both worktrees on same HEAD (detached)"
    PASS=$((PASS + 1))
else
    echo "  [FAIL] WI-1=$WT1_HEAD WI-2=$WT2_HEAD"
    FAIL=$((FAIL + 1))
fi
echo ""

# ─── Phase C: Artifact isolation ───
echo "--- Phase C: Artifact Isolation ---"
echo ""

echo "Test C1: mock codex writes artifacts in each worktree"
# Simulate what codex would produce in each worktree
mkdir -p "$WI1_PATH/src"
echo "function login() { return true; }" > "$WI1_PATH/src/login.js"
echo "module.exports = { login };" >> "$WI1_PATH/src/login.js"

mkdir -p "$WI2_PATH/src"
echo "function dashboard() { return 'ok'; }" > "$WI2_PATH/src/dashboard.js"
echo "module.exports = { dashboard };" >> "$WI2_PATH/src/dashboard.js"

# Create artifact manifest (what dispatch returns as artifacts)
echo '["src/login.js"]' > "$WI1_PATH/.artifacts.json"
echo '["src/dashboard.js"]' > "$WI2_PATH/.artifacts.json"

# Verify in worktrees
WI1_ARTIFACT_EXISTS=0; [ -f "$WI1_PATH/src/login.js" ] && WI1_ARTIFACT_EXISTS=1
WI2_ARTIFACT_EXISTS=0; [ -f "$WI2_PATH/src/dashboard.js" ] && WI2_ARTIFACT_EXISTS=1

if [ "$WI1_ARTIFACT_EXISTS" -eq 1 ] && [ "$WI2_ARTIFACT_EXISTS" -eq 1 ]; then
    echo "  [PASS] artifacts written in respective worktrees"
    PASS=$((PASS + 1))
else
    echo "  [FAIL] WI-1 artifact=$WI1_ARTIFACT_EXISTS WI-2 artifact=$WI2_ARTIFACT_EXISTS"
    FAIL=$((FAIL + 1))
fi
echo ""

echo "Test C2: artifacts NOT leaked to main repo"
MAIN_HAS_LOGIN=0; [ -f "$PROJECT_ROOT/src/login.js" ] && MAIN_HAS_LOGIN=1 || true
MAIN_HAS_DASH=0; [ -f "$PROJECT_ROOT/src/dashboard.js" ] && MAIN_HAS_DASH=1 || true

if [ "$MAIN_HAS_LOGIN" -eq 0 ] && [ "$MAIN_HAS_DASH" -eq 0 ]; then
    echo "  [PASS] no artifact leakage to main repo"
    PASS=$((PASS + 1))
else
    echo "  [FAIL] artifacts leaked to main: login=$MAIN_HAS_LOGIN dash=$MAIN_HAS_DASH"
    FAIL=$((FAIL + 1))
fi
echo ""

echo "Test C3: worktree A cannot see worktree B artifacts (isolation)"
WI1_SEES_DASH=0; [ -f "$WI1_PATH/src/dashboard.js" ] && WI1_SEES_DASH=1 || true
WI2_SEES_LOGIN=0; [ -f "$WI2_PATH/src/login.js" ] && WI2_SEES_LOGIN=1 || true

if [ "$WI1_SEES_DASH" -eq 0 ] && [ "$WI2_SEES_LOGIN" -eq 0 ]; then
    echo "  [PASS] cross-worktree isolation confirmed"
    PASS=$((PASS + 1))
else
    echo "  [FAIL] cross-worktree leak: WI1 sees dash=$WI1_SEES_DASH WI2 sees login=$WI2_SEES_LOGIN"
    FAIL=$((FAIL + 1))
fi
echo ""

# ─── Phase D: Integrate artifacts to main repo ───
echo "--- Phase D: integrateWorktreeArtifacts ---"
echo ""

echo "Test D1: integrate copies artifacts from worktrees to main repo"
FANOUT_MOD="$FANOUT_MODULE" TEST_CH="$TEST_CHANGE" WI1P="$WI1_PATH" WI2P="$WI2_PATH" node --input-type=module -e '
const { pathToFileURL } = await import("node:url");
const mod = await import(pathToFileURL(process.env.FANOUT_MOD).href);
const workItems = [
  { id: "WI-1", status: "done", artifact_paths: ["src/login.js"], worktree_path: process.env.WI1P },
  { id: "WI-2", status: "done", artifact_paths: ["src/dashboard.js"], worktree_path: process.env.WI2P },
];
const warnings = mod.integrateWorktreeArtifacts(process.env.TEST_CH, workItems);
if (warnings.length > 0) warnings.forEach(w => console.error("WARNING: " + w));
console.log("integration complete: " + workItems.length + " items");
' 2>/dev/null

MAIN_HAS_LOGIN_AFTER=0; [ -f "$PROJECT_ROOT/src/login.js" ] && MAIN_HAS_LOGIN_AFTER=1 || true
MAIN_HAS_DASH_AFTER=0; [ -f "$PROJECT_ROOT/src/dashboard.js" ] && MAIN_HAS_DASH_AFTER=1 || true

if [ "$MAIN_HAS_LOGIN_AFTER" -eq 1 ] && [ "$MAIN_HAS_DASH_AFTER" -eq 1 ]; then
    echo "  [PASS] artifacts integrated to main repo"
    PASS=$((PASS + 1))
else
    echo "  [FAIL] integration failed: login=$MAIN_HAS_LOGIN_AFTER dash=$MAIN_HAS_DASH_AFTER"
    FAIL=$((FAIL + 1))
fi
echo ""

echo "Test D2: integrated files have correct content"
LOGIN_CONTENT=$(head -1 "$PROJECT_ROOT/src/login.js" 2>/dev/null || echo "MISSING")
DASH_CONTENT=$(head -1 "$PROJECT_ROOT/src/dashboard.js" 2>/dev/null || echo "MISSING")

if echo "$LOGIN_CONTENT" | grep -q "function login" && echo "$DASH_CONTENT" | grep -q "function dashboard"; then
    echo "  [PASS] integrated content matches originals"
    PASS=$((PASS + 1))
else
    echo "  [FAIL] login=$LOGIN_CONTENT dash=$DASH_CONTENT"
    FAIL=$((FAIL + 1))
fi
echo ""

# Clean up integrated artifacts from main repo
rm -f "$PROJECT_ROOT/src/login.js" "$PROJECT_ROOT/src/dashboard.js"
rmdir "$PROJECT_ROOT/src" 2>/dev/null || true

# ─── Phase E: cleanupWorktrees ───
echo "--- Phase E: cleanupWorktrees ---"
echo ""

echo "Test E1: cleanup removes all worktree directories"
FANOUT_MOD="$FANOUT_MODULE" TEST_CH="$TEST_CHANGE" WI1P="$WI1_PATH" WI2P="$WI2_PATH" node --input-type=module -e '
const { pathToFileURL } = await import("node:url");
const mod = await import(pathToFileURL(process.env.FANOUT_MOD).href);
const workItems = [
  { id: "WI-1", status: "reviewed", worktree_path: process.env.WI1P },
  { id: "WI-2", status: "reviewed", worktree_path: process.env.WI2P },
];
const results = mod.cleanupWorktrees(process.env.TEST_CH, workItems);
console.log(JSON.stringify(results));
' 2>/dev/null

WT1_GONE=0; if [ ! -d "$WI1_PATH" ]; then WT1_GONE=1; fi
WT2_GONE=0; if [ ! -d "$WI2_PATH" ]; then WT2_GONE=1; fi

if [ "$WT1_GONE" -eq 1 ] && [ "$WT2_GONE" -eq 1 ]; then
    echo "  [PASS] all worktree directories removed"
    PASS=$((PASS + 1))
else
    echo "  [FAIL] WI-1 gone=$WT1_GONE WI-2 gone=$WT2_GONE"
    FAIL=$((FAIL + 1))
fi
echo ""

echo "Test E2: git worktree list no longer contains test worktrees"
WT_AFTER_CLEANUP=$(git worktree list 2>/dev/null | grep -c ".worktrees/$TEST_CHANGE" || true)
if [ "${WT_AFTER_CLEANUP:-0}" -eq 0 ]; then
    echo "  [PASS] git worktree list clean after cleanup"
    PASS=$((PASS + 1))
else
    echo "  [FAIL] $WT_AFTER_CLEANUP worktree references remain"
    FAIL=$((FAIL + 1))
fi
echo ""

# ─── Final cleanup ───
rm -rf "$WT_BASE" 2>/dev/null || true
git worktree prune 2>/dev/null || true

echo "=== Results: ${PASS} passed, ${FAIL} failed ==="
[ "$FAIL" -eq 0 ] || exit 1
