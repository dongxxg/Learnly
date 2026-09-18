#!/usr/bin/env python3
"""
Tests for _safeBackendInfo fallback value (P2-003)

背景：
  cli-commands.js 的 _safeBackendInfo() 在 getBackendInfo() 抛错时返回 fallback。
  原 fallback name 错写为 "ClaudeBackend"，但 ClaudeBackend 实例 this.name = "Claude Code"，
  fallback 与实例不对齐，dispatch-prompt 输出的 backend.name 在 fallback 路径上语义错位。

修复：
  fallback name 改为 "Claude Code"，并 export 纯函数 fallbackBackendInfo() 供单测验证。
"""

import json
import os
import subprocess
import sys
import unittest

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, "..", "..", "..", ".."))
CLI_COMMANDS = os.path.join(
    PROJECT_ROOT, ".claude", "skills", "rd-auto", "scripts", "lib", "cli-commands.js"
)


def _call_fallback():
    js = """
import { pathToFileURL } from 'node:url';
const mod = await import(pathToFileURL(process.env.MODULE_PATH).href);
const out = mod.fallbackBackendInfo();
process.stdout.write(JSON.stringify(out));
"""
    env = os.environ.copy()
    env["MODULE_PATH"] = CLI_COMMANDS
    result = subprocess.run(
        ["node", "--input-type=module", "-e", js],
        capture_output=True, text=True, env=env, cwd=PROJECT_ROOT,
    )
    if result.returncode != 0:
        raise AssertionError(
            f"node failed rc={result.returncode}:\nstderr={result.stderr}\nstdout={result.stdout}"
        )
    return json.loads(result.stdout.strip())


class TestSafeBackendInfoFallback(unittest.TestCase):
    """P2-003: fallback 值必须与 ClaudeBackend 实例对齐。"""

    def test_fallback_type_is_claude(self):
        """fallback type 必须为 'claude'（dispatch-prompt 主会话按 type 分流）。"""
        info = _call_fallback()
        self.assertEqual(info["type"], "claude")

    def test_fallback_name_is_claude_code(self):
        """
        fallback name 必须为 'Claude Code'，与 ClaudeBackend 实例 this.name 对齐
        （claude-backend.js:13 `this.name = 'Claude Code'`）。
        旧实现错写为 'ClaudeBackend'（类名而非实例 name）。
        """
        info = _call_fallback()
        self.assertEqual(info["name"], "Claude Code")
        self.assertNotEqual(info["name"], "ClaudeBackend",
                            "fallback name 不得为 'ClaudeBackend'（类名）")

    def test_fallback_has_only_type_and_name(self):
        """fallback 应只含 type + name 两个字段，与 happy-path _safeBackendInfo 输出对齐。"""
        info = _call_fallback()
        self.assertEqual(set(info.keys()), {"type", "name"})


if __name__ == "__main__":
    unittest.main(verbosity=2)
