#!/usr/bin/env bash
# Functional tests for spec-check.sh (Tasks 3.1, 3.2)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SPEC_CHECK="${SCRIPT_DIR}/../spec-check.sh"
GIT_CMD="git -c core.hooksPath=/dev/null"
PASS=0
FAIL=0
CLEANUP_DIRS=""

cleanup() {
    for d in ${CLEANUP_DIRS}; do
        rm -rf "${d}"
    done
}
trap cleanup EXIT

run_test() {
    local test_name="$1"
    local expected_exit="$2"
    local test_dir="$3"
    local msg="$4"

    echo -n "  ${test_name}: "

    local actual_exit=0
    (cd "${test_dir}" && bash "${SPEC_CHECK}") > /dev/null 2>&1 || actual_exit=$?

    if [ "${actual_exit}" -eq "${expected_exit}" ]; then
        echo "PASS"
        PASS=$((PASS + 1))
    else
        echo "FAIL (expected exit=${expected_exit}, got exit=${actual_exit}) — ${msg}"
        FAIL=$((FAIL + 1))
    fi
}

if [ ! -f "${SPEC_CHECK}" ]; then
    echo "SKIP: spec-check.sh not found at ${SPEC_CHECK}"
    exit 1
fi

echo "spec-check.sh Functional Tests"
echo "=============================="

create_git_repo() {
    local dir="$(mktemp -d)"
    CLEANUP_DIRS="${CLEANUP_DIRS} ${dir}"
    (
        cd "${dir}"
        ${GIT_CMD} init --quiet
        ${GIT_CMD} config user.name "test"
        ${GIT_CMD} config user.email "test@test.com"
        ${GIT_CMD} checkout -b main --quiet 2>/dev/null || true
        mkdir -p .harness/spec
        touch .harness/spec/.gitkeep
        ${GIT_CMD} add .harness/spec/.gitkeep
        ${GIT_CMD} commit -m "initial" --quiet
    )
    echo "${dir}"
}

# Test 1: No SPEC directory → skip
D1=$(create_git_repo)
run_test "no SPEC directory (skip)" 0 "${D1}" "should exit 0 when .harness/spec/changes/ absent"

# Test 2: Empty SPEC directory → skip
D2=$(create_git_repo)
mkdir -p "${D2}/.harness/spec/changes"
touch "${D2}/.harness/spec/changes/.gitkeep"
(
    cd "${D2}"
    ${GIT_CMD} add .harness/spec/changes/
    ${GIT_CMD} commit -m "empty changes dir" --quiet
)
run_test "empty SPEC directory (skip)" 0 "${D2}" "should exit 0 when changes dir is empty"

# Test 3: Complete SPEC → pass
D3=$(create_git_repo)
mkdir -p "${D3}/.harness/spec/changes/test-change"
echo "Test proposal" > "${D3}/.harness/spec/changes/test-change/proposal.md"
echo "Test design" > "${D3}/.harness/spec/changes/test-change/design.md"
echo "Test tasks" > "${D3}/.harness/spec/changes/test-change/tasks.md"
(
    cd "${D3}"
    ${GIT_CMD} add .harness/spec/changes/
    ${GIT_CMD} commit -m "complete spec" --quiet
)
run_test "complete SPEC (pass)" 0 "${D3}" "all 3 files present and non-empty"

# Test 4: Missing proposal.md → block
D4=$(create_git_repo)
mkdir -p "${D4}/.harness/spec/changes/test-change"
echo "Test design" > "${D4}/.harness/spec/changes/test-change/design.md"
echo "Test tasks" > "${D4}/.harness/spec/changes/test-change/tasks.md"
(
    cd "${D4}"
    ${GIT_CMD} add .harness/spec/changes/
    ${GIT_CMD} commit -m "missing proposal" --quiet
)
run_test "missing proposal.md (block)" 1 "${D4}" "proposal.md absent, must exit 1"

# Test 5: Missing design.md → block
D5=$(create_git_repo)
mkdir -p "${D5}/.harness/spec/changes/test-change"
echo "Test proposal" > "${D5}/.harness/spec/changes/test-change/proposal.md"
echo "Test tasks" > "${D5}/.harness/spec/changes/test-change/tasks.md"
(
    cd "${D5}"
    ${GIT_CMD} add .harness/spec/changes/
    ${GIT_CMD} commit -m "missing design" --quiet
)
run_test "missing design.md (block)" 1 "${D5}" "design.md absent, must exit 1"

# Test 6: Missing tasks.md → block
D6=$(create_git_repo)
mkdir -p "${D6}/.harness/spec/changes/test-change"
echo "Test proposal" > "${D6}/.harness/spec/changes/test-change/proposal.md"
echo "Test design" > "${D6}/.harness/spec/changes/test-change/design.md"
(
    cd "${D6}"
    ${GIT_CMD} add .harness/spec/changes/
    ${GIT_CMD} commit -m "missing tasks" --quiet
)
run_test "missing tasks.md (block)" 1 "${D6}" "tasks.md absent, must exit 1"

# Test 7: Empty proposal.md → block
D7=$(create_git_repo)
mkdir -p "${D7}/.harness/spec/changes/test-change"
echo -n "" > "${D7}/.harness/spec/changes/test-change/proposal.md"
echo "Test design" > "${D7}/.harness/spec/changes/test-change/design.md"
echo "Test tasks" > "${D7}/.harness/spec/changes/test-change/tasks.md"
(
    cd "${D7}"
    ${GIT_CMD} add .harness/spec/changes/
    ${GIT_CMD} commit -m "empty proposal" --quiet
)
run_test "empty proposal.md (block)" 1 "${D7}" "proposal.md empty, must exit 1"

# Test 8: Empty design.md → block
D8=$(create_git_repo)
mkdir -p "${D8}/.harness/spec/changes/test-change"
echo "Test proposal" > "${D8}/.harness/spec/changes/test-change/proposal.md"
echo -n "" > "${D8}/.harness/spec/changes/test-change/design.md"
echo "Test tasks" > "${D8}/.harness/spec/changes/test-change/tasks.md"
(
    cd "${D8}"
    ${GIT_CMD} add .harness/spec/changes/
    ${GIT_CMD} commit -m "empty design" --quiet
)
run_test "empty design.md (block)" 1 "${D8}" "design.md empty, must exit 1"

# Test 9: Empty tasks.md → block
D9=$(create_git_repo)
mkdir -p "${D9}/.harness/spec/changes/test-change"
echo "Test proposal" > "${D9}/.harness/spec/changes/test-change/proposal.md"
echo "Test design" > "${D9}/.harness/spec/changes/test-change/design.md"
echo -n "" > "${D9}/.harness/spec/changes/test-change/tasks.md"
(
    cd "${D9}"
    ${GIT_CMD} add .harness/spec/changes/
    ${GIT_CMD} commit -m "empty tasks" --quiet
)
run_test "empty tasks.md (block)" 1 "${D9}" "tasks.md empty, must exit 1"

echo "=============================="
echo "Results: ${PASS} passed, ${FAIL} failed"
if [ "${FAIL}" -gt 0 ]; then
    exit 1
fi
exit 0
