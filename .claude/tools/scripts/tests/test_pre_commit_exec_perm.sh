#!/usr/bin/env bash
# Tests for pre-commit hook: script-only execute permission auto-fix (.sh/.py → 755)
# 2026-07-10 (965bc1e) hook 收窄为仅修脚本文件：非脚本 .md/.json 不再被误设 755，
# 本测试同步断言对齐（旧断言期望所有文件 → 755 已过期）。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PRE_COMMIT_HOOK="${SCRIPT_DIR}/../../../hooks/git/pre-commit"
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

pass() { echo "PASS"; PASS=$((PASS + 1)); }
fail() { echo "FAIL — $1"; FAIL=$((FAIL + 1)); }

echo "pre-commit exec-perm Tests"
echo "=========================="

create_git_repo() {
    local dir
    dir="$(mktemp -d)"
    CLEANUP_DIRS="${CLEANUP_DIRS} ${dir}"
    (
        cd "${dir}"
        ${GIT_CMD} init --quiet
        ${GIT_CMD} config user.name "test"
        ${GIT_CMD} config user.email "test@test.com"
        ${GIT_CMD} checkout -b main --quiet 2>/dev/null || true
    )
    echo "${dir}"
}

get_index_mode() {
    local repo="$1"
    local file="$2"
    (cd "${repo}" && git ls-files -s -- "$file" | cut -d' ' -f1 | sed 's/100//')
}

# Test 1: .sh file → 755
echo -n "  .sh → 755: "
D1=$(create_git_repo)
printf '#!/usr/bin/env bash\necho hello\n' > "${D1}/script.sh"
(cd "${D1}" && ${GIT_CMD} add script.sh && bash "${PRE_COMMIT_HOOK}" 2>/dev/null || true)
MODE=$(get_index_mode "${D1}" "script.sh")
[ "$MODE" = "755" ] && pass || fail "expected 755, got ${MODE}"

# Test 2: .json file → 保持 644（非脚本不修权限）
echo -n "  .json → 644 (unchanged): "
D2=$(create_git_repo)
printf '{"key": "value"}\n' > "${D2}/config.json"
(cd "${D2}" && ${GIT_CMD} add config.json && bash "${PRE_COMMIT_HOOK}" 2>/dev/null || true)
MODE=$(get_index_mode "${D2}" "config.json")
[ "$MODE" = "644" ] && pass || fail "expected 644, got ${MODE}"

# Test 3: .md file → 保持 644（非脚本不修权限）
echo -n "  .md → 644 (unchanged): "
D3=$(create_git_repo)
printf '# Title\nbody\n' > "${D3}/readme.md"
(cd "${D3}" && ${GIT_CMD} add readme.md && bash "${PRE_COMMIT_HOOK}" 2>/dev/null || true)
MODE=$(get_index_mode "${D3}" "readme.md")
[ "$MODE" = "644" ] && pass || fail "expected 644, got ${MODE}"

# Test 4: empty file → 755
echo -n "  empty file → 755: "
D4=$(create_git_repo)
printf '' > "${D4}/empty.sh"
(cd "${D4}" && ${GIT_CMD} add empty.sh && bash "${PRE_COMMIT_HOOK}" 2>/dev/null || true)
MODE=$(get_index_mode "${D4}" "empty.sh")
[ "$MODE" = "755" ] && pass || fail "expected 755, got ${MODE}"

# Test 5: already 755 → unchanged (idempotent)
echo -n "  already 755 unchanged: "
D5=$(create_git_repo)
printf '#!/usr/bin/env bash\necho ok\n' > "${D5}/ok.sh"
(
    cd "${D5}"
    ${GIT_CMD} add ok.sh
    ${GIT_CMD} update-index --chmod=+x ok.sh
    BEFORE=$(git ls-files -s -- ok.sh | cut -d' ' -f1)
    bash "${PRE_COMMIT_HOOK}" 2>/dev/null || true
    AFTER=$(git ls-files -s -- ok.sh | cut -d' ' -f1)
    [ "$BEFORE" = "$AFTER" ] || exit 99
) || true
[ "$?" != "99" ] && pass || fail "755 file was modified"

# Test 6: multiple files in one commit（脚本 → 755，非脚本保持 644）
echo -n "  mixed: script → 755, non-script → 644: "
D6=$(create_git_repo)
printf 'content' > "${D6}/a.py"
printf 'content' > "${D6}/b.json"
printf 'content' > "${D6}/c.sh"
(cd "${D6}" && ${GIT_CMD} add a.py b.json c.sh && bash "${PRE_COMMIT_HOOK}" 2>/dev/null || true)
MA=$(get_index_mode "${D6}" "a.py")
MB=$(get_index_mode "${D6}" "b.json")
MC=$(get_index_mode "${D6}" "c.sh")
[ "$MA" = "755" ] && [ "$MB" = "644" ] && [ "$MC" = "755" ] && pass \
    || fail "a=${MA} b=${MB} c=${MC}, expected 755/644/755"

echo "=========================="
echo "Results: ${PASS} passed, ${FAIL} failed"
[ "${FAIL}" -gt 0 ] && exit 1
exit 0
