#!/usr/bin/env bash
# Test: fanout-context-role-fix (C001-C010, T.1-T.11)
#
# Covers:
#   C001: <output_format> combined schema (score/p0_count/concerns)
#   C002: {agent_path} placeholder filled
#   C003: getAgentContent throw + _validateSkipBuildPrompt + prompt_warnings
#   C004/C007: createWorktrees reuse (any role, not just reviewer)
#   C008: parseTasksMd regex accepts ## N. (period) format
#   C009: claude path catch has exit_status: BLOCKED
#   C010: prompt_warnings uses local variable (no instance variable race)
#   T.1-T.5, T.7, T.10: integration tests
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR"/../../../.. && pwd)"
FANOUT_LIB="$PROJECT_ROOT/.claude/skills/rd-auto/scripts/lib"
FANOUT_MODULE="$FANOUT_LIB/fanout.js"
CODEX_BACKEND="$PROJECT_ROOT/.claude/backends/codex-backend.js"
FANOUT_AGENT="$PROJECT_ROOT/.claude/skills/rd-auto/scripts/fanout-dispatch-agent.js"
TEMPLATE="$PROJECT_ROOT/.claude/skills/rd-auto/templates/dispatch-fanout.md"
CONSTANTS_MOD="$FANOUT_LIB/constants.js"
CONTEXT_PACK_MOD="$FANOUT_LIB/context-pack.js"

PASS=0
FAIL=0
CLEANUP_DIRS=""

cleanup() {
    # Clean worktrees
    for d in "$PROJECT_ROOT/.harness/.worktrees"/test-fanout-crf-*; do
        if [ -d "$d" ]; then
            for sub in "$d"/*; do
                [ -d "$sub" ] && git worktree remove --force "$sub" 2>/dev/null || true
            done
        fi
    done
    rm -rf "$PROJECT_ROOT/.harness/.worktrees"/test-fanout-crf-* 2>/dev/null || true
    # Clean test changes
    rm -rf "$PROJECT_ROOT/.harness/spec/changes"/test-fanout-crf-* 2>/dev/null || true
    rm -rf "$PROJECT_ROOT/.harness/tasks"/test-fanout-crf-* 2>/dev/null || true
    # Clean fake bin
    for d in ${CLEANUP_DIRS}; do
        rm -rf "${d}" 2>/dev/null || true
    done
    git worktree prune 2>/dev/null || true
}
trap cleanup EXIT
cleanup

echo "=== fanout-context-role-fix Tests ==="
echo ""

# ─── Group 1: parseTasksMd regex (C008) ───

echo "--- Group 1: parseTasksMd regex (C008) ---"

# Test 1: ## 1. Title (period after number) -> parsed
echo "Test 1: parseTasksMd accepts '## 1. Title' (period format)"
RESULT=$(FANOUT_MOD="$FANOUT_MODULE" node --input-type=module -e '
import { pathToFileURL } from "node:url";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
const mod = await import(pathToFileURL(process.env.FANOUT_MOD).href);
const tmpDir = "/tmp/test-c008-period-" + Date.now();
mkdirSync(tmpDir, { recursive: true });
writeFileSync(join(tmpDir, "tasks.md"), "## 1. Implement feature X\n- [ ] task a\n## 2. Implement feature Y\n- [ ] task b\n");
const result = mod.parseTasksMd(tmpDir);
console.log(JSON.stringify(result));
' 2>&1 || true)
if echo "$RESULT" | grep -q '"WI-1"' && echo "$RESULT" | grep -q '"WI-2"'; then
    echo "  [PASS] period format parsed correctly"
    PASS=$((PASS + 1))
else
    echo "  [FAIL] period format not parsed: $RESULT"
    FAIL=$((FAIL + 1))
fi
echo ""

# Test 2: ## 1 Title (space, backward compat)
echo "Test 2: parseTasksMd backward compat '## 1 Title' (space format)"
RESULT=$(FANOUT_MOD="$FANOUT_MODULE" node --input-type=module -e '
import { pathToFileURL } from "node:url";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
const mod = await import(pathToFileURL(process.env.FANOUT_MOD).href);
const tmpDir = "/tmp/test-c008-space-" + Date.now();
mkdirSync(tmpDir, { recursive: true });
writeFileSync(join(tmpDir, "tasks.md"), "## 1 Implement feature X\n- [ ] task a\n");
const result = mod.parseTasksMd(tmpDir);
console.log(JSON.stringify(result));
' 2>&1 || true)
if echo "$RESULT" | grep -q '"WI-1"'; then
    echo "  [PASS] space format still parsed (backward compat)"
    PASS=$((PASS + 1))
else
    echo "  [FAIL] space format not parsed: $RESULT"
    FAIL=$((FAIL + 1))
fi
echo ""

# Test 3: ### 1.1. Title (sub-section with period)
echo "Test 3: parseTasksMd accepts '### 1.1. Title' (sub-section period format)"
RESULT=$(FANOUT_MOD="$FANOUT_MODULE" node --input-type=module -e '
import { pathToFileURL } from "node:url";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
const mod = await import(pathToFileURL(process.env.FANOUT_MOD).href);
const tmpDir = "/tmp/test-c008-sub-" + Date.now();
mkdirSync(tmpDir, { recursive: true });
writeFileSync(join(tmpDir, "tasks.md"), "## 1. Group A\n### 1.1. Task one\n### 1.2. Task two\n");
const result = mod.parseTasksMd(tmpDir);
console.log(JSON.stringify(result));
' 2>&1 || true)
if echo "$RESULT" | grep -q '"WI-1.1"' && echo "$RESULT" | grep -q '"WI-1.2"'; then
    echo "  [PASS] sub-section period format parsed correctly"
    PASS=$((PASS + 1))
else
    echo "  [FAIL] sub-section period format not parsed: $RESULT"
    FAIL=$((FAIL + 1))
fi
echo ""

# ─── Group 2: createWorktrees reuse (C007) ───

echo "--- Group 2: createWorktrees reuse (C007) ---"

TEST_CHANGE_WT="test-fanout-crf-wt-$(date +%s)"
WT_BASE="$PROJECT_ROOT/.harness/.worktrees/$TEST_CHANGE_WT"

# Test 4: existing worktree -> reused (not removed+recreated)
echo "Test 4: createWorktrees reuses existing worktree (any role)"
# First create a worktree with content
mkdir -p "$WT_BASE/WI-1"
git worktree add --detach "$WT_BASE/WI-1" HEAD 2>/dev/null
echo "first-impl-content" > "$WT_BASE/WI-1/impl.txt"

RESULT=$(FANOUT_MOD="$FANOUT_MODULE" TEST_CH="$TEST_CHANGE_WT" node --input-type=module -e '
import { pathToFileURL } from "node:url";
const mod = await import(pathToFileURL(process.env.FANOUT_MOD).href);
const r = mod.createWorktrees(process.env.TEST_CH, [
  { work_item_id: "WI-1", role: "reviewer", description: "review 1" },
]);
console.log(JSON.stringify(r));
' 2>&1 || true)

# Check: worktree was reused (impl.txt still exists)
if [ -f "$WT_BASE/WI-1/impl.txt" ]; then
    CONTENT=$(cat "$WT_BASE/WI-1/impl.txt")
    if [ "$CONTENT" = "first-impl-content" ]; then
        echo "  [PASS] worktree reused (content preserved)"
        PASS=$((PASS + 1))
    else
        echo "  [FAIL] worktree reused but content changed: $CONTENT"
        FAIL=$((FAIL + 1))
    fi
else
    echo "  [FAIL] worktree content destroyed (impl.txt missing)"
    FAIL=$((FAIL + 1))
fi
echo ""

# Test 5: developer rework reuses first impl worktree (C007 core)
echo "Test 5: createWorktrees developer rework reuses existing worktree"
# impl.txt should still exist from test 4
if [ -f "$WT_BASE/WI-1/impl.txt" ]; then
    RESULT=$(FANOUT_MOD="$FANOUT_MODULE" TEST_CH="$TEST_CHANGE_WT" node --input-type=module -e '
import { pathToFileURL } from "node:url";
const mod = await import(pathToFileURL(process.env.FANOUT_MOD).href);
const r = mod.createWorktrees(process.env.TEST_CH, [
  { work_item_id: "WI-1", role: "developer", description: "[rework] task 1" },
]);
console.log(JSON.stringify(r));
' 2>&1 || true)
    if [ -f "$WT_BASE/WI-1/impl.txt" ]; then
        echo "  [PASS] developer rework reuses worktree (content preserved)"
        PASS=$((PASS + 1))
    else
        echo "  [FAIL] developer rework destroyed worktree"
        FAIL=$((FAIL + 1))
    fi
else
    echo "  [SKIP] precondition not met (impl.txt missing)"
fi
echo ""

# Test 6: non-existent worktree -> created
echo "Test 6: createWorktrees creates new worktree when path doesn't exist"
RESULT=$(FANOUT_MOD="$FANOUT_MODULE" TEST_CH="$TEST_CHANGE_WT" node --input-type=module -e '
import { pathToFileURL } from "node:url";
const mod = await import(pathToFileURL(process.env.FANOUT_MOD).href);
const r = mod.createWorktrees(process.env.TEST_CH, [
  { work_item_id: "WI-2", role: "developer", description: "new task" },
]);
console.log(JSON.stringify(r));
' 2>&1 || true)
if [ -d "$WT_BASE/WI-2" ] && echo "$RESULT" | grep -q '"worktree_path"'; then
    echo "  [PASS] new worktree created"
    PASS=$((PASS + 1))
else
    echo "  [FAIL] new worktree not created: $RESULT"
    FAIL=$((FAIL + 1))
fi
echo ""

# Cleanup worktrees for next tests
git worktree remove --force "$WT_BASE/WI-1" 2>/dev/null || true
git worktree remove --force "$WT_BASE/WI-2" 2>/dev/null || true
rm -rf "$WT_BASE" 2>/dev/null || true
git worktree prune 2>/dev/null || true

# ─── Group 3: _validateSkipBuildPrompt (C003) ───

echo "--- Group 3: _validateSkipBuildPrompt (C003) ---"

# Test 7: valid prompt -> {valid: true, missing: []}
echo "Test 7: _validateSkipBuildPrompt valid prompt returns {valid: true}"
RESULT=$(CODEX_MOD="$CODEX_BACKEND" node --input-type=module -e '
import { pathToFileURL } from "node:url";
const mod = await import(pathToFileURL(process.env.CODEX_MOD).href);
const backend = new mod.CodexBackend({});
const result = backend._validateSkipBuildPrompt("<agent_definition>\nrole content\n</agent_definition>\n<relevant_rules>\nrules\n</relevant_rules>");
console.log(JSON.stringify(result));
' 2>&1 || true)
if echo "$RESULT" | grep -q '"valid":true' && echo "$RESULT" | grep -q '"missing":\[\]'; then
    echo "  [PASS] valid prompt detected correctly"
    PASS=$((PASS + 1))
else
    echo "  [FAIL] expected valid:true, got: $RESULT"
    FAIL=$((FAIL + 1))
fi
echo ""

# Test 8: missing agent_definition -> {valid: false, missing: ['agent_definition']}
echo "Test 8: _validateSkipBuildPrompt missing agent_definition"
RESULT=$(CODEX_MOD="$CODEX_BACKEND" node --input-type=module -e '
import { pathToFileURL } from "node:url";
const mod = await import(pathToFileURL(process.env.CODEX_MOD).href);
const backend = new mod.CodexBackend({});
const result = backend._validateSkipBuildPrompt("<relevant_rules>\nrules\n</relevant_rules>");
console.log(JSON.stringify(result));
' 2>&1 || true)
if echo "$RESULT" | grep -q '"valid":false' && echo "$RESULT" | grep -q '"agent_definition"'; then
    echo "  [PASS] missing agent_definition detected"
    PASS=$((PASS + 1))
else
    echo "  [FAIL] expected missing agent_definition, got: $RESULT"
    FAIL=$((FAIL + 1))
fi
echo ""

# Test 9: missing relevant_rules -> {valid: false, missing: ['relevant_rules']}
echo "Test 9: _validateSkipBuildPrompt missing relevant_rules"
RESULT=$(CODEX_MOD="$CODEX_BACKEND" node --input-type=module -e '
import { pathToFileURL } from "node:url";
const mod = await import(pathToFileURL(process.env.CODEX_MOD).href);
const backend = new mod.CodexBackend({});
const result = backend._validateSkipBuildPrompt("<agent_definition>\nrole\n</agent_definition>");
console.log(JSON.stringify(result));
' 2>&1 || true)
if echo "$RESULT" | grep -q '"valid":false' && echo "$RESULT" | grep -q '"relevant_rules"'; then
    echo "  [PASS] missing relevant_rules detected"
    PASS=$((PASS + 1))
else
    echo "  [FAIL] expected missing relevant_rules, got: $RESULT"
    FAIL=$((FAIL + 1))
fi
echo ""

# Test 10: empty prompt -> {valid: false, missing: ['prompt_empty']}
echo "Test 10: _validateSkipBuildPrompt empty prompt"
RESULT=$(CODEX_MOD="$CODEX_BACKEND" node --input-type=module -e '
import { pathToFileURL } from "node:url";
const mod = await import(pathToFileURL(process.env.CODEX_MOD).href);
const backend = new mod.CodexBackend({});
const result = backend._validateSkipBuildPrompt("");
console.log(JSON.stringify(result));
' 2>&1 || true)
if echo "$RESULT" | grep -q '"valid":false' && echo "$RESULT" | grep -q '"prompt_empty"'; then
    echo "  [PASS] empty prompt detected"
    PASS=$((PASS + 1))
else
    echo "  [FAIL] expected prompt_empty, got: $RESULT"
    FAIL=$((FAIL + 1))
fi
echo ""

# Test 10b: _buildPrompt format also recognized (=== markers)
echo "Test 10b: _validateSkipBuildPrompt recognizes === 角色定义 === format"
RESULT=$(CODEX_MOD="$CODEX_BACKEND" node --input-type=module -e '
import { pathToFileURL } from "node:url";
const mod = await import(pathToFileURL(process.env.CODEX_MOD).href);
const backend = new mod.CodexBackend({});
const result = backend._validateSkipBuildPrompt("=== 角色定义 ===\nrole\n=== 框架规则 ===\nrules");
console.log(JSON.stringify(result));
' 2>&1 || true)
if echo "$RESULT" | grep -q '"valid":true'; then
    echo "  [PASS] === format recognized"
    PASS=$((PASS + 1))
else
    echo "  [FAIL] === format not recognized: $RESULT"
    FAIL=$((FAIL + 1))
fi
echo ""

# ─── Group 4: dispatch-fanout.md template (C001, C002, role-aware) ───

echo "--- Group 4: dispatch-fanout.md template (C001, C002) ---"

# Test 11: <output_format> contains score/p0_count/concerns (C001)
echo "Test 11: dispatch-fanout.md <output_format> has combined schema (C001)"
if grep -q 'score' "$TEMPLATE" && grep -q 'p0_count' "$TEMPLATE" && grep -q 'concerns' "$TEMPLATE"; then
    echo "  [PASS] combined schema present (score/p0_count/concerns)"
    PASS=$((PASS + 1))
else
    echo "  [FAIL] combined schema missing"
    FAIL=$((FAIL + 1))
fi
echo ""

# Test 12: template has {role_label}, {action_description}, {role_specific_instructions}
echo "Test 12: dispatch-fanout.md has role-aware placeholders"
ROLE_LABEL_OK=$(grep -c '{role_label}' "$TEMPLATE" || true)
ACTION_DESC_OK=$(grep -c '{action_description}' "$TEMPLATE" || true)
ROLE_INSTR_OK=$(grep -c '{role_specific_instructions}' "$TEMPLATE" || true)
if [ "$ROLE_LABEL_OK" -gt 0 ] && [ "$ACTION_DESC_OK" -gt 0 ] && [ "$ROLE_INSTR_OK" -gt 0 ]; then
    echo "  [PASS] role-aware placeholders present"
    PASS=$((PASS + 1))
else
    echo "  [FAIL] role-aware placeholders missing: role_label=$ROLE_LABEL_OK action=$ACTION_DESC_OK instr=$ROLE_INSTR_OK"
    FAIL=$((FAIL + 1))
fi
echo ""

# Test 13: template has {agent_path} (C002 - to be filled by wrapper)
echo "Test 13: dispatch-fanout.md has {agent_path} placeholder (C002)"
if grep -q '{agent_path}' "$TEMPLATE"; then
    echo "  [PASS] {agent_path} placeholder present in template"
    PASS=$((PASS + 1))
else
    echo "  [FAIL] {agent_path} placeholder missing from template"
    FAIL=$((FAIL + 1))
fi
echo ""

# ─── Group 5: Integration (fanout-dispatch-agent.js, claude backend) ───

echo "--- Group 5: Integration (fanout-dispatch-agent.js) ---"

# Setup: create test change
TEST_CHANGE="test-fanout-crf-$(date +%s)"
STATE_DIR="$PROJECT_ROOT/.harness/tasks/$TEST_CHANGE"
CHANGE_DIR="$PROJECT_ROOT/.harness/spec/changes/$TEST_CHANGE"
mkdir -p "$STATE_DIR" "$CHANGE_DIR"
TIMESTAMP=$(date -Iseconds)

# tasks.md with period format (C008)
cat > "$CHANGE_DIR/tasks.md" << 'TASKSEOF'
## 1. Implement core module
- [ ] task a
- [ ] task b
## 2. Implement review module
- [ ] task c
TASKSEOF

# design.md with Decisions section (for assembleContextPack)
cat > "$CHANGE_DIR/design.md" << 'DESIGNEOF'
# Design: test change

## Decisions

- D1: Use TDD approach
- D2: Modular architecture
DESIGNEOF

# pipeline-state.json with team mode + implement phase
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

# Run fanout-dispatch-agent.js with claude backend (outputs prompts as JSON)
OUT=$(HARNESS_BACKEND=claude CLAUDE_PROJECT_DIR="$PROJECT_ROOT" node "$FANOUT_AGENT" "$TEST_CHANGE" 2>&1 || true)

# Test 14: output has invoke_fanout_agents action
echo "Test 14: fanout-dispatch-agent outputs invoke_fanout_agents (claude backend)"
if echo "$OUT" | grep -q '"invoke_fanout_agents"'; then
    echo "  [PASS] action=invoke_fanout_agents"
    PASS=$((PASS + 1))
else
    echo "  [FAIL] unexpected output: $(echo "$OUT" | head -3)"
    FAIL=$((FAIL + 1))
fi
echo ""

# Extract first agent prompt for content checks
PROMPT_JSON=$(echo "$OUT" | node -e '
let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
  try {
    const o=JSON.parse(s);
    if (o.agents && o.agents.length > 0) {
      console.log(JSON.stringify({prompt: o.agents[0].prompt, role: o.agents[0].role, count: o.agents.length}));
    } else {
      console.log(JSON.stringify({error: "no agents", raw: s.slice(0,200)}));
    }
  } catch(e) {
    console.log(JSON.stringify({error: e.message, raw: s.slice(0,200)}));
  }
})' 2>/dev/null || echo '{"error":"parse failed"}')

AGENT_COUNT=$(echo "$PROMPT_JSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const o=JSON.parse(s);console.log(o.count||0)}catch{console.log(0)}})' 2>/dev/null || echo "0")
FIRST_PROMPT=$(echo "$PROMPT_JSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const o=JSON.parse(s);console.log(o.prompt||"")}catch{console.log("")}})' 2>/dev/null || echo "")

# Test 15: prompt contains non-empty <agent_definition> (T.1)
echo "Test 15: prompt has non-empty <agent_definition> (T.1)"
if echo "$FIRST_PROMPT" | grep -q '<agent_definition>' && echo "$FIRST_PROMPT" | grep -q '</agent_definition>'; then
    # Check content between tags is non-empty (exclude the tag lines themselves)
    AGENT_INNER=$(echo "$FIRST_PROMPT" | sed -n '/<agent_definition>/,/<\/agent_definition>/p' | grep -v '<agent_definition>' | grep -v '</agent_definition>' | grep -v '^$' | head -3)
    if [ ${#AGENT_INNER} -gt 10 ]; then
        echo "  [PASS] <agent_definition> non-empty"
        PASS=$((PASS + 1))
    else
        echo "  [FAIL] <agent_definition> appears empty (inner content too short)"
        FAIL=$((FAIL + 1))
    fi
else
    echo "  [FAIL] <agent_definition> tags not found"
    FAIL=$((FAIL + 1))
fi
echo ""

# Test 16: prompt contains non-empty <relevant_rules> (T.1)
echo "Test 16: prompt has non-empty <relevant_rules> (T.1)"
if echo "$FIRST_PROMPT" | grep -q '<relevant_rules>'; then
    RULES_CONTENT=$(echo "$FIRST_PROMPT" | sed -n '/<relevant_rules>/,/<\/relevant_rules>/p' | wc -c)
    if [ "$RULES_CONTENT" -gt 30 ]; then
        echo "  [PASS] <relevant_rules> non-empty"
        PASS=$((PASS + 1))
    else
        echo "  [FAIL] <relevant_rules> appears empty"
        FAIL=$((FAIL + 1))
    fi
else
    echo "  [FAIL] <relevant_rules> not found"
    FAIL=$((FAIL + 1))
fi
echo ""

# Test 17: prompt contains non-empty <project_context> (T.1)
echo "Test 17: prompt has non-empty <project_context> (T.1)"
if echo "$FIRST_PROMPT" | grep -q '<project_context>'; then
    CTX_CONTENT=$(echo "$FIRST_PROMPT" | sed -n '/<project_context>/,/<\/project_context>/p' | wc -c)
    if [ "$CTX_CONTENT" -gt 30 ]; then
        echo "  [PASS] <project_context> non-empty"
        PASS=$((PASS + 1))
    else
        echo "  [FAIL] <project_context> appears empty"
        FAIL=$((FAIL + 1))
    fi
else
    echo "  [FAIL] <project_context> not found"
    FAIL=$((FAIL + 1))
fi
echo ""

# Test 18: developer prompt has "Developer" + "实现" (T.2)
echo "Test 18: developer prompt has role 'Developer' + action '实现' (T.2)"
if echo "$FIRST_PROMPT" | grep -q 'Developer' && echo "$FIRST_PROMPT" | grep -q '实现'; then
    echo "  [PASS] developer prompt has correct role + action"
    PASS=$((PASS + 1))
else
    echo "  [FAIL] developer prompt missing role/action"
    FAIL=$((FAIL + 1))
fi
echo ""

# Test 19: prompt <output_format> has score/p0_count/concerns (T.4, C001)
echo "Test 19: prompt <output_format> has combined schema (T.4, C001)"
if echo "$FIRST_PROMPT" | grep -q 'score' && echo "$FIRST_PROMPT" | grep -q 'p0_count' && echo "$FIRST_PROMPT" | grep -q 'concerns'; then
    echo "  [PASS] combined schema in rendered prompt"
    PASS=$((PASS + 1))
else
    echo "  [FAIL] combined schema missing from rendered prompt"
    FAIL=$((FAIL + 1))
fi
echo ""

# Test 20: prompt has no literal {agent_path} (T.5, C002)
echo "Test 20: prompt has no literal {agent_path} (T.5, C002)"
if echo "$FIRST_PROMPT" | grep -q '{agent_path}'; then
    echo "  [FAIL] literal {agent_path} found in prompt (not filled)"
    FAIL=$((FAIL + 1))
else
    echo "  [PASS] no literal {agent_path} in prompt"
    PASS=$((PASS + 1))
fi
echo ""

# Test 21: prompt has no other unfilled placeholders
echo "Test 21: prompt has no unfilled {role_label}/{action_description}/{role_specific_instructions}"
if echo "$FIRST_PROMPT" | grep -q '{role_label}' || echo "$FIRST_PROMPT" | grep -q '{action_description}' || echo "$FIRST_PROMPT" | grep -q '{role_specific_instructions}'; then
    echo "  [FAIL] unfilled role-aware placeholder found"
    FAIL=$((FAIL + 1))
else
    echo "  [PASS] all role-aware placeholders filled"
    PASS=$((PASS + 1))
fi
echo ""

# Cleanup integration test worktrees
for d in "$PROJECT_ROOT/.harness/.worktrees/$TEST_CHANGE"/*; do
    [ -d "$d" ] && git worktree remove --force "$d" 2>/dev/null || true
done
rm -rf "$PROJECT_ROOT/.harness/.worktrees/$TEST_CHANGE" 2>/dev/null || true
git worktree prune 2>/dev/null || true

# ─── Group 6: C009 - claude path catch has exit_status: BLOCKED ───

echo "--- Group 6: C009 - claude path catch exit_status ---"

# Test 22: source code has exit_status: 'BLOCKED' in claude catch block (C009)
echo "Test 22: fanout-dispatch-agent.js claude catch has exit_status (C009)"
# Check that the claude path catch block (prompt: null) includes exit_status
CLAUDE_CATCH_OK=$(awk '/backendType === .claude./,/^  \/\/ ─── Codex/' "$FANOUT_AGENT" | grep -c "exit_status.*BLOCKED" || true)
if [ "$CLAUDE_CATCH_OK" -gt 0 ]; then
    echo "  [PASS] claude catch block has exit_status: BLOCKED"
    PASS=$((PASS + 1))
else
    echo "  [FAIL] claude catch block missing exit_status: BLOCKED"
    FAIL=$((FAIL + 1))
fi
echo ""

# ─── Group 7: prompt_warnings via dispatchSubAgent (C003, C010) ───

echo "--- Group 7: prompt_warnings via dispatchSubAgent (C003, C010) ---"

# Setup fake codex
FAKE_BIN="$(mktemp -d)"
CLEANUP_DIRS="${CLEANUP_DIRS} ${FAKE_BIN}"

cat > "$FAKE_BIN/codex" << 'EOF'
#!/usr/bin/env bash
# Output a valid codex JSONL response with agent_message containing JSON
cat <<'CODEXOUT'
{"type":"item.completed","item":{"type":"agent_message","text":"```json\n{\"exit_status\":\"DONE\",\"summary\":\"ok\"}\n```"}}
{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":50}}
CODEXOUT
EOF
chmod +x "$FAKE_BIN/codex"

# Test 23: dispatchSubAgent with invalid prompt returns prompt_warnings (T.7, C003)
echo "Test 23: dispatchSubAgent returns prompt_warnings for invalid prompt (T.7)"
RESULT=$(PATH="$FAKE_BIN:${PATH}" CODEX_MOD="$CODEX_BACKEND" node --input-type=module -e '
import { pathToFileURL } from "node:url";
const mod = await import(pathToFileURL(process.env.CODEX_MOD).href);
const backend = new mod.CodexBackend({});
// Prompt missing <agent_definition> and <relevant_rules>
const result = await backend.dispatchSubAgent("developer", "bare prompt no markers", {
  skipBuildPrompt: true,
  phase: "implement",
  timeoutMs: 5000,
  cwd: process.cwd(),
});
console.log(JSON.stringify({has_warnings: !!result.prompt_warnings, warnings: result.prompt_warnings || null}));
' 2>&1 || true)
if echo "$RESULT" | grep -q '"has_warnings":true'; then
    echo "  [PASS] prompt_warnings returned"
    PASS=$((PASS + 1))
else
    echo "  [FAIL] no prompt_warnings: $RESULT"
    FAIL=$((FAIL + 1))
fi
echo ""

# Test 24: dispatchSubAgent with valid prompt has no prompt_warnings
echo "Test 24: dispatchSubAgent valid prompt has no prompt_warnings"
RESULT=$(PATH="$FAKE_BIN:${PATH}" CODEX_MOD="$CODEX_BACKEND" node --input-type=module -e '
import { pathToFileURL } from "node:url";
const mod = await import(pathToFileURL(process.env.CODEX_MOD).href);
const backend = new mod.CodexBackend({});
const validPrompt = "<agent_definition>\nrole\n</agent_definition>\n<relevant_rules>\nrules\n</relevant_rules>\ntask content";
const result = await backend.dispatchSubAgent("developer", validPrompt, {
  skipBuildPrompt: true,
  phase: "implement",
  timeoutMs: 5000,
  cwd: process.cwd(),
});
console.log(JSON.stringify({has_warnings: !!result.prompt_warnings, warnings: result.prompt_warnings || null}));
' 2>&1 || true)
if echo "$RESULT" | grep -q '"has_warnings":false' || echo "$RESULT" | grep -q '"warnings":null'; then
    echo "  [PASS] no prompt_warnings for valid prompt"
    PASS=$((PASS + 1))
else
    echo "  [FAIL] unexpected warnings: $RESULT"
    FAIL=$((FAIL + 1))
fi
echo ""

# ─── Group 8: Syntax check (linter zero error) ───

echo "--- Group 8: Syntax check ---"

# Test 25: node --check all modified files
echo "Test 25: syntax check all modified JS files"
SYNTAX_OK=1
for f in "$FANOUT_AGENT" "$FANOUT_MODULE" "$CODEX_BACKEND"; do
    if ! node --check "$f" 2>/dev/null; then
        echo "  [FAIL] syntax error in $f"
        SYNTAX_OK=0
    fi
done
if [ "$SYNTAX_OK" -eq 1 ]; then
    echo "  [PASS] all JS files pass syntax check"
    PASS=$((PASS + 1))
else
    FAIL=$((FAIL + 1))
fi
echo ""

# ─── Summary ───

echo "=== Results: ${PASS} passed, ${FAIL} failed ==="
if [ "$FAIL" -gt 0 ]; then
    exit 1
fi
