#!/usr/bin/env bash
# test_backend_detection.sh — 测试后端检测和基本功能

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR"/../../../.. && pwd)"
ORCHESTRATOR="$PROJECT_ROOT/.claude/skills/rd-auto/scripts/orchestrator.js"

echo "=== Backend Detection Test ==="
echo ""

# Test 1: 默认后端检测
echo "Test 1: Default backend detection"
node "$ORCHESTRATOR" backend-info
echo ""

# Test 2: 显式选择 Claude 后端
echo "Test 2: Explicit Claude backend"
HARNESS_BACKEND=claude node "$ORCHESTRATOR" backend-info
echo ""

# Test 3: 显式选择 Codex 后端（如果可用）
echo "Test 3: Explicit Codex backend"
if command -v codex &>/dev/null; then
  HARNESS_BACKEND=codex node "$ORCHESTRATOR" backend-info
else
  echo "Codex CLI not installed, skipping..."
fi
echo ""

# Test 4: 显式选择 DeepSeek Harness 后端
echo "Test 4: Explicit DeepSeek Harness backend"
HARNESS_BACKEND=dsh node "$ORCHESTRATOR" backend-info
echo ""

echo "=== Tests Complete ==="
