#!/usr/bin/env bash
# runner.sh — run all issue-board unit test suites and summarize PASS/FAIL.
#
# Style aligned with .claude/tools/scripts/tests/test_spec_check.sh.
# Exit non-zero if any suite fails.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PASS=0
FAIL=0
FAILED_SUITES=""

for t in "${SCRIPT_DIR}"/test_*.sh; do
  [ -f "${t}" ] || continue
  name=$(basename "${t}")
  printf '→ %s ... ' "${name}"
  if bash "${t}" >/tmp/ib_runner_$$.out 2>&1; then
    echo "PASS"
    PASS=$((PASS+1))
  else
    echo "FAIL"
    FAIL=$((FAIL+1))
    FAILED_SUITES="${FAILED_SUITES} ${name}"
    # Surface the failing output for visibility.
    tail -n 20 /tmp/ib_runner_$$.out | sed 's/^/    /'
  fi
  rm -f /tmp/ib_runner_$$.out
done

echo ""
echo "Results: ${PASS} suite(s) passed, ${FAIL} suite(s) failed"
if [ "${FAIL}" -gt 0 ]; then
  echo "Failed suites:${FAILED_SUITES}"
  exit 1
fi
exit 0
