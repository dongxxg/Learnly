#!/usr/bin/env bash
# test_ci_run_agent.sh — 测试 ci-run-agent.js 后端路由
#
# 覆盖：
#   1) Claude 后端：通过 HARNESS_BACKEND=claude，验证调用 claude -p
#   2) Codex 后端：通过 HARNESS_BACKEND=codex，验证调用 codex exec
#   3) Qoder 后端：通过 HARNESS_BACKEND=qoder，验证调用 qoderclicn headless
#   4) 自动检测：未设 HARNESS_BACKEND 时默认 Claude（CLAUDE_CODE_SESSION_ID）
#
# 使用 fake claude/codex 脚本接收 argv，写入 capture 文件供断言。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR"/../../../.. && pwd)"
CI_RUN_AGENT="$PROJECT_ROOT/.claude/tools/scripts/ci/ci-run-agent.js"

PASS=0
FAIL=0
CLEANUP_DIRS=""

cleanup() {
  for d in ${CLEANUP_DIRS}; do
    rm -rf "${d}"
  done
}
trap cleanup EXIT

if [ ! -f "${CI_RUN_AGENT}" ]; then
  echo "SKIP: ci-run-agent.js not found at ${CI_RUN_AGENT}"
  exit 0
fi

echo "=== ci-run-agent.js Backend Routing Test ==="
echo ""

# ─── Helper ───
run_agent() {
  local backend="$1"
  local prompt="$2"
  local model="${3:-sonnet}"
  local max_turns="${4:-10}"
  local tools="${5:-Read,Write}"
  local fmt="${6:-json}"

  HARNESS_BACKEND="${backend}" \
    node "${CI_RUN_AGENT}" \
      --model "${model}" \
      --max-turns "${max_turns}" \
      --allowed-tools "${tools}" \
      --output-format "${fmt}" 2>/dev/null <<< "${prompt}"
  return $?
}

# ─── Test 1: Claude backend calls claude -p ───
echo "Test 1: Claude backend routes to claude -p"
FAKE_BIN="$(mktemp -d)"
CAPTURE_FILE="$(mktemp)"
CLEANUP_DIRS="${FAKE_BIN} ${CAPTURE_FILE}"

cat > "${FAKE_BIN}/claude" <<'SCRIPT'
#!/usr/bin/env bash
echo "ARGC=$#" >> "${CAPTURE_FILE}"
echo "ARG0=$1" >> "${CAPTURE_FILE}"
for arg in "$@"; do
  echo "ARG: $arg" >> "${CAPTURE_FILE}"
done
echo '{"result":"ok"}'
exit 0
SCRIPT
chmod +x "${FAKE_BIN}/claude"

# No codex in this fake bin (ensure codex detection doesn't trigger)
export CAPTURE_FILE
PATH="${FAKE_BIN}:${PATH}" HARNESS_BACKEND=claude \
  node "${CI_RUN_AGENT}" \
    --model sonnet --max-turns 5 --allowed-tools "Read,Write" --output-format json \
    2>/dev/null <<< "hello claude" || true

if grep -qF -- '-p' "${CAPTURE_FILE}" 2>/dev/null; then
  echo "  [PASS] claude -p flag found"
  PASS=$((PASS + 1))
else
  echo "  [FAIL] claude -p flag not found in captured args"
  cat "${CAPTURE_FILE}"
  FAIL=$((FAIL + 1))
fi

# Test 1b: prompt is passed to claude
if grep -qF 'hello claude' "${CAPTURE_FILE}" 2>/dev/null; then
  echo "  [PASS] prompt passed to claude"
  PASS=$((PASS + 1))
else
  echo "  [FAIL] prompt not found in captured args"
  FAIL=$((FAIL + 1))
fi

# ─── Test 2: Codex backend calls codex exec ───
echo "Test 2: Codex backend routes to codex exec"

FAKE_BIN2="$(mktemp -d)"
CAPTURE_FILE2="$(mktemp)"
CLEANUP_DIRS="${CLEANUP_DIRS} ${FAKE_BIN2} ${CAPTURE_FILE2}"

cat > "${FAKE_BIN2}/codex" <<'SCRIPT'
#!/usr/bin/env bash
echo "ARGC=$#" >> "${CAPTURE_FILE2}"
for arg in "$@"; do
  echo "ARG: $arg" >> "${CAPTURE_FILE2}"
done
echo '{"result":"ok from codex"}'
exit 0
SCRIPT
chmod +x "${FAKE_BIN2}/codex"

export CAPTURE_FILE2
PATH="${FAKE_BIN2}:${PATH}" HARNESS_BACKEND=codex \
  node "${CI_RUN_AGENT}" \
    --model sonnet --max-turns 5 --allowed-tools "Read,Write" --output-format json \
    2>/dev/null <<< "hello codex" || true

if grep -qF 'exec' "${CAPTURE_FILE2}" 2>/dev/null; then
  echo "  [PASS] codex exec invoked"
  PASS=$((PASS + 1))
else
  echo "  [FAIL] codex exec not found in captured args"
  cat "${CAPTURE_FILE2}"
  FAIL=$((FAIL + 1))
fi

if grep -qF 'hello codex' "${CAPTURE_FILE2}" 2>/dev/null; then
  echo "  [PASS] prompt passed to codex"
  PASS=$((PASS + 1))
else
  echo "  [FAIL] prompt not found in captured codex args"
  FAIL=$((FAIL + 1))
fi

# ─── Test 3: Qoder backend calls qoderclicn headless ───
echo "Test 3: Qoder backend routes to qoderclicn headless"

FAKE_BIN_QODER="$(mktemp -d)"
CAPTURE_FILE_QODER="$(mktemp)"
CLEANUP_DIRS="${CLEANUP_DIRS} ${FAKE_BIN_QODER} ${CAPTURE_FILE_QODER}"

cat > "${FAKE_BIN_QODER}/qoderclicn" <<'SCRIPT'
#!/usr/bin/env bash
for arg in "$@"; do
  echo "ARG: $arg" >> "${CAPTURE_FILE_QODER}"
done
echo '{"result":"ok from qoder"}'
exit 0
SCRIPT
chmod +x "${FAKE_BIN_QODER}/qoderclicn"

export CAPTURE_FILE_QODER
PATH="${FAKE_BIN_QODER}:${PATH}" HARNESS_BACKEND=qoder \
  node "${CI_RUN_AGENT}" \
    --model performance --max-turns 7 --allowed-tools "Read,Write" --output-format json \
    2>/dev/null <<< "hello qoder" || true

QODER_OK=1
for expected in '--print' '--permission-mode' 'auto' '--max-turns' '7' '--allowed-tools' 'Read,Write' '--output-format' 'json' 'hello qoder'; do
  if ! grep -qF -- "$expected" "${CAPTURE_FILE_QODER}" 2>/dev/null; then
    echo "  [FAIL] qoderclicn missing arg: $expected"
    cat "${CAPTURE_FILE_QODER}" 2>/dev/null || true
    FAIL=$((FAIL + 1))
    QODER_OK=0
    break
  fi
done
if [ "$QODER_OK" -eq 1 ]; then
  echo "  [PASS] qoderclicn headless args passed"
  PASS=$((PASS + 1))
fi

# ─── Test 4: Default backend (no HARNESS_BACKEND, set CLAUDE_CODE_SESSION_ID) ───
echo "Test 4: Default backend (CLAUDE_CODE_SESSION_ID set) routes to claude"

FAKE_BIN3="$(mktemp -d)"
CAPTURE_FILE3="$(mktemp)"
CLEANUP_DIRS="${CLEANUP_DIRS} ${FAKE_BIN3} ${CAPTURE_FILE3}"

cat > "${FAKE_BIN3}/claude" <<'SCRIPT'
#!/usr/bin/env bash
echo "DEFAULT_CLAUDE" >> "${CAPTURE_FILE3}"
echo '{"result":"ok"}'
exit 0
SCRIPT
chmod +x "${FAKE_BIN3}/claude"

export CAPTURE_FILE3
PATH="${FAKE_BIN3}:${PATH}" CLAUDE_CODE_SESSION_ID=test-sid-123 \
  node "${CI_RUN_AGENT}" \
    --model sonnet --max-turns 3 --allowed-tools "Read" --output-format json \
    2>/dev/null <<< "default test" || true

if grep -qF 'DEFAULT_CLAUDE' "${CAPTURE_FILE3}" 2>/dev/null; then
  echo "  [PASS] default backend (Claude via CLAUDE_CODE_SESSION_ID) invoked"
  PASS=$((PASS + 1))
else
  echo "  [FAIL] default backend not invoked"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "=== Results: ${PASS} passed, ${FAIL} failed ==="

if [ "${FAIL}" -gt 0 ]; then
  exit 1
fi
exit 0
