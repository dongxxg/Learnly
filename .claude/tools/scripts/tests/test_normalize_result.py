#!/usr/bin/env python3
"""
Tests for normalizeDispatchResult (tasks 3.4)

覆盖：
  - claude 路径：snake_case 原样映射
  - codex 路径：camelCase → snake_case
  - 错误路径：error 字段 → exit_status=BLOCKED + escalate_reason
  - 空/未知输入
"""

import json
import os
import subprocess
import sys
import unittest

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, "..", "..", "..", ".."))
NORMALIZE_MOD = os.path.join(
    PROJECT_ROOT, ".claude", "skills", "rd-auto", "scripts", "lib", "normalize-result.js"
)


def call_normalize(backend_type, raw_result):
    js = """
import { pathToFileURL } from 'node:url';
const mod = await import(pathToFileURL(process.env.MODULE_PATH).href);
const out = mod.normalizeDispatchResult(
  process.env.BACKEND_TYPE,
  JSON.parse(process.env.RAW_RESULT || 'null')
);
process.stdout.write(JSON.stringify(out));
"""
    env = os.environ.copy()
    env["MODULE_PATH"] = NORMALIZE_MOD
    env["BACKEND_TYPE"] = backend_type
    env["RAW_RESULT"] = json.dumps(raw_result)
    result = subprocess.run(
        ["node", "--input-type=module", "-e", js],
        capture_output=True,
        text=True,
        env=env,
        cwd=PROJECT_ROOT,
    )
    if result.returncode != 0:
        raise AssertionError(
            f"node failed rc={result.returncode}:\nstderr={result.stderr}\nstdout={result.stdout}"
        )
    return json.loads(result.stdout)


class TestNormalizeResult(unittest.TestCase):

    def test_claude_path_pass_through(self):
        """claude 路径：原样映射 snake_case。"""
        raw = {
            "exit_status": "DONE",
            "summary": "implemented feature X",
            "artifacts": ["a.py", "b.py"],
            "score": 85,
            "p0_count": 0,
        }
        result = call_normalize("claude", raw)
        self.assertEqual(result["exit_status"], "DONE")
        self.assertEqual(result["summary"], "implemented feature X")
        self.assertEqual(result["artifacts"], ["a.py", "b.py"])
        self.assertEqual(result["score"], 85)
        self.assertEqual(result["p0_count"], 0)

    def test_claude_path_missing_exit_status(self):
        """claude 路径：缺失 exit_status → DONE_WITH_CONCERNS。"""
        result = call_normalize("claude", {"summary": "x"})
        self.assertEqual(result["exit_status"], "DONE_WITH_CONCERNS")

    def test_codex_path_done_with_summary(self):
        """codex 路径：DONE + summary/artifacts 转换。"""
        raw = {
            "exitStatus": "DONE",
            "output": "raw text",
            "summary": "已实现",
            "artifacts": ["f1.js"],
        }
        result = call_normalize("codex", raw)
        self.assertEqual(result["exit_status"], "DONE")
        self.assertEqual(result["summary"], "已实现")
        self.assertEqual(result["artifacts"], ["f1.js"])

    def test_codex_path_done_with_concerns(self):
        """codex 路径：DONE_WITH_CONCERNS + concerns。"""
        raw = {
            "exitStatus": "DONE_WITH_CONCERNS",
            "output": "raw",
            "concerns": [{"level": "P2", "type": "unparseable-codex-output"}],
        }
        result = call_normalize("codex", raw)
        self.assertEqual(result["exit_status"], "DONE_WITH_CONCERNS")
        self.assertEqual(len(result["concerns"]), 1)
        self.assertEqual(result["concerns"][0]["type"], "unparseable-codex-output")

    def test_codex_path_error_blocks(self):
        """codex 路径：error 字段 → BLOCKED + escalate_reason。"""
        raw = {
            "exitStatus": "BLOCKED",
            "error": {"type": "auth_failure", "message": "401 Unauthorized"},
        }
        result = call_normalize("codex", raw)
        self.assertEqual(result["exit_status"], "BLOCKED")
        self.assertIn("escalate_reason", result)
        self.assertIn("auth_failure", result["escalate_reason"])

    def test_codex_path_error_string_form(self):
        """codex 路径：error 是 string 也支持。"""
        raw = {"exitStatus": "BLOCKED", "error": "command not found"}
        result = call_normalize("codex", raw)
        self.assertEqual(result["exit_status"], "BLOCKED")
        self.assertIn("escalate_reason", result)

    def test_codex_path_no_summary_falls_back_to_output(self):
        """codex 路径：无 summary 时用 output 前 200 字。"""
        raw = {"exitStatus": "DONE", "output": "fallback summary text"}
        result = call_normalize("codex", raw)
        self.assertEqual(result["exit_status"], "DONE")
        self.assertIn("fallback summary text", result["summary"])

    def test_null_input_returns_concerns(self):
        """null 输入 → DONE_WITH_CONCERNS。"""
        result = call_normalize("claude", None)
        self.assertEqual(result["exit_status"], "DONE_WITH_CONCERNS")

    def test_unknown_backend_falls_back(self):
        """未知 backend → 降级。"""
        result = call_normalize("gemini", {"exit_status": "DONE", "summary": "x"})
        self.assertEqual(result["exit_status"], "DONE")
        self.assertTrue(any(c.get("type") == "unknown-backend" for c in result.get("concerns", [])))


if __name__ == "__main__":
    unittest.main(verbosity=2)
