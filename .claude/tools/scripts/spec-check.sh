#!/usr/bin/env bash
# spec-check.sh — SPEC 变更目录完整性检查
#
# 检测逻辑：
#   1. 通过 git diff 找到 .harness/spec/changes/ 下的变更文件
#   2. 提取唯一目录名作为变更列表
#   3. 对每个变更目录检查 proposal.md / design.md / tasks.md 存在且非空
#   4. 所有检查通过 → exit 0；任一失败 → exit 1（硬阻断）
#   5. 无 SPEC 变更 → exit 0（跳过）
#
# 用法: bash spec-check.sh

set -euo pipefail

SPEC_ROOT=".harness/spec/changes"
ERROR_COUNT=0

# 确定 git diff 的基线（按优先级尝试）
# 1. CI 中 MR target branch
# 2. origin/main 存在
# 3. 本地 main 与 HEAD 不同（有未推送提交）
# 4. 回退到 HEAD~1（本地测试 / 单分支场景）
if [ -n "${CI_MERGE_REQUEST_TARGET_BRANCH_NAME:-}" ]; then
    BASE_REF="origin/${CI_MERGE_REQUEST_TARGET_BRANCH_NAME}"
elif git rev-parse --verify origin/main >/dev/null 2>&1; then
    BASE_REF="origin/main"
elif git rev-parse --verify main >/dev/null 2>&1 \
     && [ "$(git rev-parse main)" != "$(git rev-parse HEAD)" ]; then
    BASE_REF="main"
else
    BASE_REF="HEAD~1"
fi

echo "[spec-check] Using base ref: ${BASE_REF}"

# 1. 获取变更的 SPEC 文件
CHANGED_FILES=$(git diff --name-only "${BASE_REF}...HEAD" -- "${SPEC_ROOT}/" 2>/dev/null || true)

if [ -z "${CHANGED_FILES}" ]; then
    echo "[spec-check] No SPEC changes detected, skipping"
    exit 0
fi

# 2. 提取唯一子目录（仅取 .harness/spec/changes/<子目录> 层级）
CHANGED_DIRS=$(echo "${CHANGED_FILES}" | while read -r f; do
    echo "$f" | sed -n 's|^\(\.harness/spec/changes/[^/]*\)/.*|\1|p'
done | sort -u)

if [ -z "${CHANGED_DIRS}" ]; then
    echo "[spec-check] No SPEC directories to check, skipping"
    exit 0
fi

echo "[spec-check] Found changed SPEC director(ies):"
for d in ${CHANGED_DIRS}; do
    echo "  - ${d}"
done

echo ""
echo "[spec-check] Validating SPEC completeness..."

# 3. 检查每个变更目录（使用 for 循环避免 subshell 问题）
REQUIRED_FILES="proposal.md design.md tasks.md"

for spec_dir in ${CHANGED_DIRS}; do
    [ -z "${spec_dir}" ] && continue

    echo "  [${spec_dir}]"

    for req_file in ${REQUIRED_FILES}; do
        filepath="${spec_dir}/${req_file}"
        if [ ! -f "${filepath}" ]; then
            echo "    FAIL: ${req_file} is missing"
            ERROR_COUNT=$((ERROR_COUNT + 1))
        elif [ ! -s "${filepath}" ]; then
            echo "    FAIL: ${req_file} is empty"
            ERROR_COUNT=$((ERROR_COUNT + 1))
        else
            echo "    OK: ${req_file}"
        fi
    done
done

echo ""

if [ "${ERROR_COUNT}" -gt 0 ]; then
    echo "[spec-check] FAILED: ${ERROR_COUNT} issue(s) found — SPEC directories are incomplete"
    exit 1
fi

echo "[spec-check] All SPEC directories are complete"
exit 0
