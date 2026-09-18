#!/usr/bin/env bash
# Tests for collect-ai.js concerns author filter (Issue !157 + !159)
#
# 背景：collect-ai.js collectConcernStats() 不解析 --user、不按 author 过滤，
# 导致日报 concern_stats 把别人的 P0/P1 也算到自己头上。
# 本测试覆盖 6 个场景：
#   1) PASS: concerns 全是当前 user → 全部计入
#   2) PASS: concerns 全是他人 → 全部过滤掉
#   3) PASS: concerns 混合 → 只计当前 user 部分
#   4) PASS: concerns 无 author 字段（旧数据）→ 保留 + warn（不丢弃）
#   5) PASS: 未传 --user → 不过滤（保持现有行为，向后兼容）
#   6) PASS: collect-all.js 两处 safeCollect 都传 --user
#
# 测试用 mktemp -d 造 mock concerns.json，不污染真实仓库。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
COLLECT_AI="${SCRIPT_DIR}/../../../skills/daily-report/scripts/collect-ai.js"
COLLECT_ALL="${SCRIPT_DIR}/../../../skills/daily-report/scripts/collect-all.js"

PASS=0
FAIL=0
CLEANUP_DIRS=""

cleanup() {
    for d in ${CLEANUP_DIRS}; do
        rm -rf "${d}"
    done
}
trap cleanup EXIT

if [ ! -f "${COLLECT_AI}" ]; then
    echo "SKIP: collect-ai.js not found at ${COLLECT_AI}"
    exit 1
fi

# --- helpers ---

mk_tmp_repo() {
    local d
    d=$(mktemp -d)
    CLEANUP_DIRS="${CLEANUP_DIRS} ${d}"
    mkdir -p "${d}/.harness/shared-state"
    mkdir -p "${d}/.harness/tasks"
    echo "${d}"
}

# write_concerns <repo-dir> <change-name> <json-content>
write_concerns() {
    local repo="$1"
    local change="$2"
    local json="$3"
    mkdir -p "${repo}/.harness/shared-state/${change}"
    printf '%s' "${json}" > "${repo}/.harness/shared-state/${change}/concerns.json"
}

# run_collect_ai <repo-dir> <extra-args...>
# Outputs stdout (the collected JSON).
run_collect_ai() {
    local repo="$1"
    shift
    node "${COLLECT_AI}" --date 2026-05-22 --cwd "${repo}" "$@"
}

# extract_concern_total <stdout-json>
extract_total() {
    node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).summary.concern_stats.total)}catch(e){console.log('ERR:'+e.message)}})"
}

assert_eq() {
    local label="$1"
    local expected="$2"
    local actual="$3"
    if [ "${expected}" = "${actual}" ]; then
        echo "PASS: ${label} (expected=${expected} actual=${actual})"
        PASS=$((PASS + 1))
    else
        echo "FAIL: ${label} (expected=${expected} actual=${actual})"
        FAIL=$((FAIL + 1))
    fi
}

# --- Test 1: concerns 全是当前 user → 全部计入 ---
test_all_current_user() {
    local repo
    repo=$(mk_tmp_repo)
    write_concerns "${repo}" "change-A" '{"version":"1.0","reviewer":"AI-Reviewer","timestamp":"2026-05-22T10:00:00Z","concerns":[
        {"id":"C001","severity":"P0","status":"open","file":"a.js","line":1,"type":"correctness","description":"p0","author":"alice"},
        {"id":"C002","severity":"P1","status":"resolved","file":"b.js","line":2,"type":"observational","description":"p1","author":"alice"}
    ]}'
    local out
    out=$(run_collect_ai "${repo}" --user alice)
    local total
    total=$(echo "${out}" | extract_total)
    assert_eq "test_all_current_user: total=2" "2" "${total}"
}

# --- Test 2: concerns 全是他人 → 全部过滤掉 ---
test_all_other_user() {
    local repo
    repo=$(mk_tmp_repo)
    write_concerns "${repo}" "change-B" '{"version":"1.0","reviewer":"AI-Reviewer","timestamp":"2026-05-22T10:00:00Z","concerns":[
        {"id":"C001","severity":"P0","status":"open","file":"a.js","line":1,"type":"correctness","description":"p0","author":"bob"},
        {"id":"C002","severity":"P1","status":"open","file":"b.js","line":2,"type":"observational","description":"p1","author":"carol"}
    ]}'
    local out
    out=$(run_collect_ai "${repo}" --user alice)
    local total
    total=$(echo "${out}" | extract_total)
    assert_eq "test_all_other_user: total=0" "0" "${total}"
}

# --- Test 3: concerns 混合 → 只计当前 user 部分 ---
test_mixed_users() {
    local repo
    repo=$(mk_tmp_repo)
    write_concerns "${repo}" "change-C" '{"version":"1.0","reviewer":"AI-Reviewer","timestamp":"2026-05-22T10:00:00Z","concerns":[
        {"id":"C001","severity":"P0","status":"open","file":"a.js","line":1,"type":"correctness","description":"p0-alice","author":"alice"},
        {"id":"C002","severity":"P0","status":"open","file":"a.js","line":2,"type":"correctness","description":"p0-bob","author":"bob"},
        {"id":"C003","severity":"P1","status":"resolved","file":"b.js","line":3,"type":"observational","description":"p1-alice","author":"alice"}
    ]}'
    local out
    out=$(run_collect_ai "${repo}" --user alice)
    local total
    total=$(echo "${out}" | extract_total)
    assert_eq "test_mixed_users: total=2 (only alice)" "2" "${total}"
}

# --- Test 4: concerns 无 author 字段（旧数据）→ 保留 + warn ---
test_legacy_no_author() {
    local repo
    repo=$(mk_tmp_repo)
    write_concerns "${repo}" "change-D" '{"version":"1.0","reviewer":"AI-Reviewer","timestamp":"2026-05-22T10:00:00Z","concerns":[
        {"id":"C001","severity":"P0","status":"open","file":"a.js","line":1,"type":"correctness","description":"no-author-1"},
        {"id":"C002","severity":"P1","status":"resolved","file":"b.js","line":2,"type":"observational","description":"no-author-2"}
    ]}'
    # Capture stdout (JSON) and stderr (warning) separately
    local stdout stderr
    stdout=$(node "${COLLECT_AI}" --date 2026-05-22 --cwd "${repo}" --user alice 2>/tmp/concerns_test_err || true)
    stderr=$(cat /tmp/concerns_test_err 2>/dev/null)
    rm -f /tmp/concerns_test_err
    local total
    total=$(echo "${stdout}" | extract_total)
    assert_eq "test_legacy_no_author: total=2 (kept, not dropped)" "2" "${total}"
    # Verify warning was emitted on stderr
    if echo "${stderr}" | grep -qi "author"; then
        echo "PASS: test_legacy_no_author emits warning mentioning author"
        PASS=$((PASS + 1))
    else
        echo "FAIL: test_legacy_no_author should warn about missing author field (stderr=${stderr})"
        FAIL=$((FAIL + 1))
    fi
}

# --- Test 5: 未传 --user → 不过滤（向后兼容） ---
test_no_user_no_filter() {
    local repo
    repo=$(mk_tmp_repo)
    write_concerns "${repo}" "change-E" '{"version":"1.0","reviewer":"AI-Reviewer","timestamp":"2026-05-22T10:00:00Z","concerns":[
        {"id":"C001","severity":"P0","status":"open","file":"a.js","line":1,"type":"correctness","description":"a","author":"alice"},
        {"id":"C002","severity":"P0","status":"open","file":"a.js","line":2,"type":"correctness","description":"b","author":"bob"},
        {"id":"C003","severity":"P0","status":"open","file":"a.js","line":3,"type":"correctness","description":"c","author":"carol"}
    ]}'
    local out
    out=$(run_collect_ai "${repo}")
    local total
    total=$(echo "${out}" | extract_total)
    assert_eq "test_no_user_no_filter: total=3 (no filter applied)" "3" "${total}"
}

# --- Test 6: collect-all.js 两处 safeCollect 都传 --user ---
# 静态检查：collect-all.js 中调用 collect-ai.js 的行必须含 --user
test_collect_all_passes_user() {
    # Count occurrences: should be 2 (current repo + sub-repos loop)
    local count
    count=$(grep -c 'collectAi.*--user' "${COLLECT_ALL}" || true)
    # The actual line pattern: safeCollect(collectAi, [... --user=user ...], ...)
    # We accept either --user=<user> or --user <user> in args array
    local hits
    hits=$(grep -E "collectAi[,:]s*\[" "${COLLECT_ALL}" \
           | grep -c '`--user=' || true)
    # Fallback: count lines mentioning both collectAi call context and --user
    # Use a more robust pattern: safeCollect(collectAi, [`--date=...`, `--user=...`, ...])
    local matches
    matches=$(grep -nE "safeCollect\(\s*collectAi" "${COLLECT_ALL}" \
              | grep -c '`--user=' || true)
    assert_eq "test_collect_all_passes_user: collect-ai safeCollect calls pass --user" "2" "${matches}"
}

# --- Runner ---
test_all_current_user
test_all_other_user
test_mixed_users
test_legacy_no_author
test_no_user_no_filter
test_collect_all_passes_user

echo "-----------------------------------------"
echo "concerns author filter: ${PASS} passed, ${FAIL} failed"

if [ "${FAIL}" -gt 0 ]; then
    exit 1
fi
