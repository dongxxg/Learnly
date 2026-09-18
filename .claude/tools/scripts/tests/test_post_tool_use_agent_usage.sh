#!/usr/bin/env bash
# Functional tests for post-tool-use-agent-usage.sh
# Tests: role mapping, duration_ms extraction, sensitive info filtering,
#        non-Agent filtering, injection defense, watermark management
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOOK="${SCRIPT_DIR}/../../../hooks/shared/post-tool-use-agent-usage.sh"
HELPER="${SCRIPT_DIR}/../../../hooks/shared/hook-json-helper.sh"
ORCHESTRATOR="${SCRIPT_DIR}/../../../skills/rd-auto/scripts/orchestrator.js"
USAGE_DIR="${SCRIPT_DIR}/../../../../.harness/usage"
USAGE_FILE="${USAGE_DIR}/usage.jsonl"

PASS=0
FAIL=0
SKIP=0
TEST_IDX=0

# ── Pre-flight checks ──
if [ ! -f "${HOOK}" ]; then
    echo "SKIP: hook not found at ${HOOK}"
    exit 0
fi
if ! command -v node &>/dev/null; then
    echo "SKIP: node not found"
    exit 0
fi

# ── Test helper ──
run_test() {
    local test_name="$1"
    local input_json="$2"
    local check_fn="$3"  # function name to call with the last line of usage.jsonl

    TEST_IDX=$((TEST_IDX + 1))
    echo -n "  ${TEST_IDX}. ${test_name}: "

    # Record line count before
    local before=0
    if [ -f "${USAGE_FILE}" ]; then
        before=$(wc -l < "${USAGE_FILE}")
    fi

    # Run hook
    echo "${input_json}" | CLAUDE_PROJECT_DIR="$(cd "${SCRIPT_DIR}/../../../.." && pwd)" \
        bash "${HOOK}" 2>/dev/null || true

    # Get last line
    local after=0
    if [ -f "${USAGE_FILE}" ]; then
        after=$(wc -l < "${USAGE_FILE}")
    fi

    local result=""
    if [ "${after}" -gt "${before}" ]; then
        result="$(tail -1 "${USAGE_FILE}")"
    fi

    # Run check
    if ${check_fn} "${result}" "${after}" "${before}"; then
        echo "PASS"
        PASS=$((PASS + 1))
    else
        echo "FAIL"
        FAIL=$((FAIL + 1))
    fi
}

run_test_no_record() {
    local test_name="$1"
    local input_json="$2"

    TEST_IDX=$((TEST_IDX + 1))
    echo -n "  ${TEST_IDX}. ${test_name}: "

    local before=0
    if [ -f "${USAGE_FILE}" ]; then
        before=$(wc -l < "${USAGE_FILE}")
    fi

    echo "${input_json}" | CLAUDE_PROJECT_DIR="$(cd "${SCRIPT_DIR}/../../../.." && pwd)" \
        bash "${HOOK}" 2>/dev/null || true

    local after=0
    if [ -f "${USAGE_FILE}" ]; then
        after=$(wc -l < "${USAGE_FILE}")
    fi

    if [ "${after}" -eq "${before}" ]; then
        echo "PASS"
        PASS=$((PASS + 1))
    else
        echo "FAIL (record should NOT have been written)"
        FAIL=$((FAIL + 1))
    fi
}

# ── JSON helper for assertions ──
json_val() {
    echo "$1" | node -e "
        let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{
            try{
                const o=JSON.parse(d);
                const parts='$2'.split('.');
                let v=o;
                for(const p of parts) v=v?.[p];
                console.log(v==null?'':String(v));
            }catch(e){console.log('');}
        });
    " 2>/dev/null
}

# ══════════════════════════════════════════════════
# Test Suite
# ══════════════════════════════════════════════════

echo ""
echo "=== post-tool-use-agent-usage.sh tests ==="
echo ""

# ── 1. Role mapping ──

echo "--- Role Mapping ---"

check_role_architect() {
    local result="$1"
    [ -z "$result" ] && return 1
    local role="$(json_val "$result" role)"
    [ "$role" = "architect" ]
}
run_test "Architect maps to architect" \
    '{"tool_name":"Agent","tool_input":{"subagent_type":"Architect","prompt":"design task"},"session_id":"test-role-arch","duration_ms":1000}' \
    check_role_architect

check_role_developer() {
    local result="$1"
    [ -z "$result" ] && return 1
    local role="$(json_val "$result" role)"
    [ "$role" = "developer" ]
}
run_test "Developer maps to developer" \
    '{"tool_name":"Agent","tool_input":{"subagent_type":"Developer","prompt":"code task"},"session_id":"test-role-dev","duration_ms":1000}' \
    check_role_developer

check_role_tester() {
    local result="$1"
    [ -z "$result" ] && return 1
    local role="$(json_val "$result" role)"
    [ "$role" = "tester" ]
}
run_test "Tester maps to tester" \
    '{"tool_name":"Agent","tool_input":{"subagent_type":"Tester","prompt":"test task"},"session_id":"test-role-tester","duration_ms":1000}' \
    check_role_tester

check_role_reviewer() {
    local result="$1"
    [ -z "$result" ] && return 1
    local role="$(json_val "$result" role)"
    [ "$role" = "reviewer" ]
}
run_test "Reviewer maps to reviewer" \
    '{"tool_name":"Agent","tool_input":{"subagent_type":"Reviewer","prompt":"review task"},"session_id":"test-role-rev","duration_ms":1000}' \
    check_role_reviewer

check_role_debate() {
    local result="$1"
    [ -z "$result" ] && return 1
    local role="$(json_val "$result" role)"
    [ "$role" = "debate" ]
}
run_test "Debate maps to debate" \
    '{"tool_name":"Agent","tool_input":{"subagent_type":"Debate","prompt":"debate task"},"session_id":"test-role-debate","duration_ms":1000}' \
    check_role_debate

check_role_custom() {
    local result="$1"
    [ -z "$result" ] && return 1
    local role="$(json_val "$result" role)"
    [ "$role" = "explore" ]
}
run_test "Custom type Explore maps to explore (lowercase)" \
    '{"tool_name":"Agent","tool_input":{"subagent_type":"Explore","prompt":"explore task"},"session_id":"test-role-explore","duration_ms":1000}' \
    check_role_custom

# ── 2. duration_ms extraction ──

echo ""
echo "--- duration_ms / started_at ---"

check_duration_populated() {
    local result="$1"
    [ -z "$result" ] && return 1
    local started="$(json_val "$result" started_at)"
    local duration="$(json_val "$result" duration_ms)"
    [ -n "$started" ] && [ "$started" != "null" ] && [ -n "$duration" ] && [ "$duration" != "null" ]
}
run_test "Numeric duration_ms produces started_at and duration_ms" \
    '{"tool_name":"Agent","tool_input":{"subagent_type":"Developer","prompt":"duration test"},"session_id":"test-dur-numeric","duration_ms":5000}' \
    check_duration_populated

check_duration_from_string() {
    local result="$1"
    [ -z "$result" ] && return 1
    local started="$(json_val "$result" started_at)"
    [ -n "$started" ] && [ "$started" != "null" ]
}
run_test "String duration_ms \"5000\" also works" \
    '{"tool_name":"Agent","tool_input":{"subagent_type":"Developer","prompt":"str dur test"},"session_id":"test-dur-str","duration_ms":"5000"}' \
    check_duration_from_string

check_no_duration() {
    local result="$1"
    [ -z "$result" ] && return 1
    local duration="$(json_val "$result" duration_ms)"
    # Should still record, just without started_at
    [ -n "$result" ]
}
run_test "Missing duration_ms still records (graceful)" \
    '{"tool_name":"Agent","tool_input":{"subagent_type":"Developer","prompt":"no dur"},"session_id":"test-no-dur"}' \
    check_no_duration

# ── 3. Task description ──

echo ""
echo "--- Task Description ---"

check_task_captured() {
    local result="$1"
    [ -z "$result" ] && return 1
    local task="$(json_val "$result" task)"
    echo "$task" | grep -q "hello world"
}
run_test "Task prompt captured in record" \
    '{"tool_name":"Agent","tool_input":{"subagent_type":"Developer","prompt":"hello world task"},"session_id":"test-task","duration_ms":1000}' \
    check_task_captured

check_sensitive_redacted() {
    local result="$1"
    [ -z "$result" ] && return 1
    local task="$(json_val "$result" task)"
    # Should NOT contain the actual secret value
    echo "$task" | grep -q "mySecretKey123" && return 1
    # Should contain REDACTED
    echo "$task" | grep -q "REDACTED" || return 1
    return 0
}
run_test "Sensitive info in prompt is redacted" \
    '{"tool_name":"Agent","tool_input":{"subagent_type":"Developer","prompt":"connect with api_key=mySecretKey123 to server"},"session_id":"test-redact","duration_ms":1000}' \
    check_sensitive_redacted

# ── 4. Tool filtering ──

echo ""
echo "--- Tool Filtering ---"

run_test_no_record "Bash tool is filtered out (no record)" \
    '{"tool_name":"Bash","tool_input":{"command":"ls -la"},"session_id":"test-filter-bash"}'

run_test_no_record "Read tool is filtered out" \
    '{"tool_name":"Read","tool_input":{"file_path":"/tmp/test"},"session_id":"test-filter-read"}'

run_test_no_record "Edit tool is filtered out" \
    '{"tool_name":"Edit","tool_input":{},"session_id":"test-filter-edit"}'

run_test_no_record "Empty tool_name is filtered out" \
    '{"tool_input":{"subagent_type":"Developer","prompt":"test"},"session_id":"test-filter-empty"}'

# ── 5. subagent_type guard ──

echo ""
echo "--- subagent_type Guard ---"

run_test_no_record "Agent without subagent_type is filtered" \
    '{"tool_name":"Agent","tool_input":{"prompt":"test"},"session_id":"test-no-subagent","duration_ms":1000}'

# ── 6. Injection defense ──

echo ""
echo "--- Injection Defense ---"

check_no_injection_in_started_at() {
    local result="$1"
    # If no record written, that's a valid pass (hook handled gracefully)
    [ -z "$result" ] && return 0
    local started="$(json_val "$result" started_at)"
    # started_at must be a valid ISO timestamp or null — never arbitrary injected text
    if [ -n "$started" ] && [ "$started" != "null" ]; then
        echo "$started" | grep -qE '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'
    else
        return 0
    fi
}

# Use printf to avoid bash quote-escaping issues with the injection payload
TEST_IDX=$((TEST_IDX + 1))
echo -n "  ${TEST_IDX}. Malformed duration_ms does not inject code: "
_INJECT_JSON='{"tool_name":"Agent","tool_input":{"subagent_type":"Developer","prompt":"inject test"},"session_id":"test-inject","duration_ms":"XXX_INJECT_XXX"}'
_INJECT_BEFORE=0
if [ -f "${USAGE_FILE}" ]; then _INJECT_BEFORE=$(wc -l < "${USAGE_FILE}"); fi
echo "${_INJECT_JSON}" | CLAUDE_PROJECT_DIR="$(cd "${SCRIPT_DIR}/../../../.." && pwd)" \
    bash "${HOOK}" 2>/dev/null || true
_INJECT_RESULT=""
_INJECT_AFTER=0
if [ -f "${USAGE_FILE}" ]; then
    _INJECT_AFTER=$(wc -l < "${USAGE_FILE}")
    if [ "${_INJECT_AFTER}" -gt "${_INJECT_BEFORE}" ]; then
        _INJECT_RESULT="$(tail -1 "${USAGE_FILE}")"
    fi
fi
if check_no_injection_in_started_at "${_INJECT_RESULT}"; then
    echo "PASS"
    PASS=$((PASS + 1))
else
    echo "FAIL"
    FAIL=$((FAIL + 1))
fi

# ── 7. Task tool name (legacy compat) ──

echo ""
echo "--- Legacy Compat ---"

check_task_tool_role() {
    local result="$1"
    [ -z "$result" ] && return 1
    local role="$(json_val "$result" role)"
    [ "$role" = "developer" ]
}
run_test "Task tool name also triggers recording" \
    '{"tool_name":"Task","tool_input":{"subagent_type":"Developer","prompt":"legacy task"},"session_id":"test-legacy-task","duration_ms":1000}' \
    check_task_tool_role

# ── 8. Watermark per-session isolation (!150) ──
#
# 根因：旧实现用全局 .last-transcript-line，跨项目/跨 session 共享。
# 项目 A 的 session 跑完写水位线 5000，项目 B 的 session 启动读到 5000，
# 但 B 的 transcript 才 100 行 → extractTokenUsage 从 line 5000 开始读 → 读不到 usage → tokens=null。
# 修复：水位线文件名包含 project_slug + session_id，做 per-session 隔离。

echo ""
echo "--- Watermark per-session isolation ---"

USAGE_DIR_TEST="${HOME}/.claude/usage"
# project_slug 由 CLAUDE_PROJECT_DIR 经 sed 编码得到，run_test 设的是项目根目录
_PROJECT_SLUG_TEST="$(echo "$(cd "${SCRIPT_DIR}/../../../.." && pwd)" | sed 's/[^a-zA-Z0-9]/-/g')"
_PROJECTS_DIR_TEST="${HOME}/.claude/projects/${_PROJECT_SLUG_TEST}"

# Cleanup from previous runs
rm -f "${USAGE_DIR_TEST}/.last-line-"*"-test-watermark-"* 2>/dev/null || true

# Stub minimal transcript files so hook can resolve _transcript_path
mkdir -p "${_PROJECTS_DIR_TEST}"
echo '{"line":1}' > "${_PROJECTS_DIR_TEST}/test-watermark-A.jsonl"
echo '{"line":1}' > "${_PROJECTS_DIR_TEST}/test-watermark-B.jsonl"

# Cleanup hook stub transcripts on exit
trap 'rm -f "${_PROJECTS_DIR_TEST}/test-watermark-A.jsonl" "${_PROJECTS_DIR_TEST}/test-watermark-B.jsonl"' EXIT

check_watermark_per_session() {
    local _result="$1"
    # Pass condition: per-session watermark file exists for session A
    local file_a
    file_a="$(ls "${USAGE_DIR_TEST}/.last-line-"*"-test-watermark-A" 2>/dev/null | head -1)"
    [ -n "$file_a" ] && [ -f "$file_a" ]
}
run_test "Watermark file is per-session (not global)" \
    '{"tool_name":"Agent","tool_input":{"subagent_type":"Developer","prompt":"watermark A"},"session_id":"test-watermark-A","duration_ms":1000}' \
    check_watermark_per_session

check_watermark_two_sessions_isolated() {
    # Dispatch B 之后，A 的水位线文件依然存在（不被 B 覆盖）
    # 两个文件必须是不同的（per-session 隔离的核心断言）
    local file_a file_b
    file_a="$(ls "${USAGE_DIR_TEST}/.last-line-"*"-test-watermark-A" 2>/dev/null | head -1)"
    file_b="$(ls "${USAGE_DIR_TEST}/.last-line-"*"-test-watermark-B" 2>/dev/null | head -1)"
    [ -n "$file_a" ] && [ -n "$file_b" ] && [ "$file_a" != "$file_b" ]
}
run_test "Two sessions get separate watermark files" \
    '{"tool_name":"Agent","tool_input":{"subagent_type":"Developer","prompt":"watermark B"},"session_id":"test-watermark-B","duration_ms":1000}' \
    check_watermark_two_sessions_isolated

# ══════════════════════════════════════════════════
# Results
# ══════════════════════════════════════════════════

echo ""
echo "=== Results ==="
echo "  PASS: ${PASS}"
echo "  FAIL: ${FAIL}"
echo ""

if [ "${FAIL}" -gt 0 ]; then
    echo "❌ Some tests failed"
    exit 1
else
    echo "✅ All tests passed"
    exit 0
fi
