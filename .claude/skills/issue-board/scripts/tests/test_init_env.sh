#!/usr/bin/env bash
# Unit tests for init_env (defined in lib/common.sh).
#
# init_env loads credentials/API URL/PROJECT_ID from env, .gitlab-config, and
# git remote. We chdir into a temp git repo so _derive_remote_url is predictable
# and point .gitlab-config at a fixture.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LIB_DIR="${SCRIPT_DIR}/../lib"

PASS=0
FAIL=0
assert_eq() {
  if [ "$1" = "$2" ]; then echo "  PASS: $3"; PASS=$((PASS+1))
  else echo "  FAIL: $3 — got '$1' want '$2'"; FAIL=$((FAIL+1)); fi
}
assert_contains() {
  if [[ "$1" == *"$2"* ]]; then echo "  PASS: $3"; PASS=$((PASS+1))
  else echo "  FAIL: $3 — '$2' not in '$1'"; FAIL=$((FAIL+1)); fi
}

# init_env is defined in common.sh. Source it (without running it).
# lib/json.sh provides json_get used by _derive_project_id at runtime.
# shellcheck disable=SC1090
source "${LIB_DIR}/json.sh"
# shellcheck disable=SC1090
source "${LIB_DIR}/common.sh"

# Build a temp git repo whose `origin` remote is deterministic so
# _derive_remote_url and _derive_project_id behave predictably. We DO NOT want
# network calls during tests, so we also stage the project-id lookup via fake
# curl in the cases that exercise it.
export PATH="${SCRIPT_DIR}/bin:${PATH}"

# CI runners inject GITLAB_TOKEN / CI_PROJECT_ID / CI_API_V4_URL into the env.
# init_env reads these as defaults, which would mask the .gitlab-config fixtures
# and break the "missing token / missing project_id" assertions. Strip them once
# at the top; tests that exercise the env-var path set them inline per-call.
unset GITLAB_TOKEN GITLAB_API_URL GITLAB_PROJECT_ID
unset CI_PROJECT_ID CI_API_V4_URL CI_PROJECT_PATH SLUG

WORK="$(mktemp -d)"
cleanup() { rm -rf "${WORK}" 2>/dev/null || true; }
trap cleanup EXIT

git_init_origin() {
  local url="$1"
  git -C "${WORK}" init --quiet 2>/dev/null || true
  git -C "${WORK}" config user.email t@t 2>/dev/null || true
  git -C "${WORK}" config user.name t 2>/dev/null || true
  git -C "${WORK})" checkout -b main --quiet 2>/dev/null || git -C "${WORK}" checkout -b master --quiet 2>/dev/null || true
  git -C "${WORK}" remote remove origin 2>/dev/null || true
  git -C "${WORK}" remote add origin "${url}" 2>/dev/null || true
}

echo "test_init_env.sh"

# ─── env vars win over .gitlab-config ───
echo "  env precedence:"
{
  cd "${WORK}"
  printf 'gitlab_token=cfg-token\ngitlab_api_url=https://cfg.example.com\ngitlab_project_id=999\n' > .gitlab-config
  TOKEN=""; API_URL=""; PROJECT_ID=""
  GITLAB_TOKEN="env-token" GITLAB_API_URL="https://env.example.com" GITLAB_PROJECT_ID="111" init_env >/dev/null 2>&1
  assert_eq "${TOKEN}" "env-token" "env GITLAB_TOKEN wins"
  assert_eq "${API_URL}" "https://env.example.com/api/v4" "env GITLAB_API_URL wins (+ /api/v4 suffix)"
  assert_eq "${PROJECT_ID}" "111" "env GITLAB_PROJECT_ID wins"
  rm -f .gitlab-config
}

# ─── .gitlab-config fills in when env missing; gitlab_group captured ───
echo "  .gitlab-config (with gitlab_group):"
{
  cd "${WORK}"
  printf 'gitlab_token=cfg-token\ngitlab_api_url=https://cfg.example.com\ngitlab_project_id=999\ngitlab_group=UniData\n' > .gitlab-config
  TOKEN=""; API_URL=""; PROJECT_ID=""; GROUP_PATH=""
  # Avoid git remote project_id override by giving a remote whose project lookup
  # we pre-bake. init_env calls _derive_project_id which hits curl; stage it.
  printf '{"id":999}' > /tmp/id_body.json
  export MOCK_CURL_RESPONSE_FILE=/tmp/id_body.json
  export MOCK_CURL_STATUS=200
  init_env >/dev/null 2>&1
  assert_eq "${TOKEN}" "cfg-token" "config token loaded"
  assert_eq "${PROJECT_ID}" "999" "config project id loaded"
  assert_eq "${GROUP_PATH}" "UniData" "gitlab_group captured to GROUP_PATH"
  # GROUP_ID should NOT be derived eagerly (lazy derivation decision).
  assert_eq "${GROUP_ID:-}" "" "GROUP_ID not eagerly derived"
  rm -f .gitlab-config /tmp/id_body.json
}

# ─── missing GITLAB_TOKEN → error ───
echo "  missing token:"
{
  cd "${WORK}"
  rm -f .gitlab-config
  TOKEN=""; API_URL="https://x/api/v4"; PROJECT_ID="1"
  set +e
  err=$(init_env 2>&1 >/dev/null); rc=$?
  set -e
  assert_eq "${rc}" "1" "missing token exits 1"
  assert_contains "${err}" "GITLAB_TOKEN" "error mentions GITLAB_TOKEN"
}

# ─── missing PROJECT_ID (and no remote to derive from) → error ───
echo "  missing project_id:"
{
  cd "${WORK}"
  printf 'gitlab_token=tk\n' > .gitlab-config
  TOKEN=""; API_URL=""; PROJECT_ID=""
  set +e
  err=$(GITLAB_API_URL="https://x.example.com" init_env 2>&1 >/dev/null); rc=$?
  set -e
  assert_eq "${rc}" "1" "missing project_id exits 1"
  assert_contains "${err}" "project ID" "error mentions project ID"
  rm -f .gitlab-config
}

# ─── API_URL /api/v4 suffix normalization ───
echo "  api url normalization:"
{
  cd "${WORK}"
  printf 'gitlab_token=tk\ngitlab_project_id=1\n' > .gitlab-config
  TOKEN=""; API_URL=""; PROJECT_ID=""
  export MOCK_CURL_RESPONSE_FILE=/dev/null  # _derive_project_id returns empty
  GITLAB_API_URL="https://host.example.com" init_env >/dev/null 2>&1 || true
  assert_eq "${API_URL}" "https://host.example.com/api/v4" "/api/v4 appended"
  rm -f .gitlab-config
}

echo "Results: ${PASS} passed, ${FAIL} failed"
if [ "${FAIL}" -gt 0 ]; then exit 1; fi
exit 0
