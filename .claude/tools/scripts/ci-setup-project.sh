#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Windows Store 的 python3 占位符（WindowsApps/python3.exe）`python3 --version`
# 无输出且 exit 49，`command -v` 能命中但实际不可用——必须用 --version 实测探测。
PY=""
if command -v python3 >/dev/null 2>&1 && python3 --version >/dev/null 2>&1; then
  PY=python3
elif command -v python >/dev/null 2>&1 && python --version >/dev/null 2>&1; then
  PY=python
fi

if [ -z "${PY}" ]; then
  echo "[ci-setup-project] 错误：未检测到可用的 python3 / python 解释器（当前环境：$(uname -s 2>/dev/null || echo unknown)）" >&2
  echo "[ci-setup-project] 请先安装 Python（https://www.python.org/downloads/），再重试 CI 配置生成" >&2
  exit 1
fi

exec "${PY}" "${SCRIPT_DIR}/ci/setup-project.py" "$@"
