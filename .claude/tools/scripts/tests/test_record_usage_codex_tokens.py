#!/usr/bin/env python3
"""
Tests for cmdRecordUsage --tokens 参数（codex 模式 token 集成）

验证：
  - --tokens 1234 + --backend codex → usage.jsonl 末尾记录 tokens={total:1234}
  - 不传 --tokens + --backend codex → tokens=null + note 提示
  - --tokens 0 / 负数 → 视为无效，tokens=null
"""

import json
import os
import subprocess
import tempfile
import unittest

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, "..", "..", "..", ".."))
ORCHESTRATOR = os.path.join(PROJECT_ROOT, ".claude", "skills", "rd-auto", "scripts", "orchestrator.js")


def _read_last_usage_record(home_dir):
    """读取 ~/.claude/usage/usage.jsonl 最后一行，返回 dict。"""
    usage_file = os.path.join(home_dir, ".claude", "usage", "usage.jsonl")
    if not os.path.exists(usage_file):
        return None
    with open(usage_file, "r", encoding="utf-8") as f:
        lines = [ln for ln in f.readlines() if ln.strip()]
    if not lines:
        return None
    return json.loads(lines[-1])


class TestRecordUsageCodexTokens(unittest.TestCase):
    """cmdRecordUsage --tokens 在 codex 模式下的行为契约。"""

    def setUp(self):
        if not os.path.exists(ORCHESTRATOR):
            self.skipTest(f"orchestrator.js not found at {ORCHESTRATOR}")
        # 用临时 HOME 隔离 usage.jsonl，避免污染真实文件
        self._tmp_home = tempfile.mkdtemp(prefix="codex-tokens-test-")
        self._original_home = os.environ.get("HOME")
        # HARNESS_USAGE_DIR / HARNESS_PROJECTS_DIR 是绝对路径，会覆盖 HOME fallback。
        # 测试用临时 HOME 隔离时必须清掉这两个 env，否则 orchestrator 写到真实 usage dir。
        self._original_usage_dir = os.environ.pop("HARNESS_USAGE_DIR", None)
        self._original_projects_dir = os.environ.pop("HARNESS_PROJECTS_DIR", None)

    def tearDown(self):
        if self._original_home is not None:
            os.environ["HOME"] = self._original_home
        if self._original_usage_dir is not None:
            os.environ["HARNESS_USAGE_DIR"] = self._original_usage_dir
        if self._original_projects_dir is not None:
            os.environ["HARNESS_PROJECTS_DIR"] = self._original_projects_dir
        # 清理临时目录（递归）
        subprocess.run(["rm", "-rf", self._tmp_home], check=False)

    def _run_record_usage(self, *extra_args):
        env = os.environ.copy()
        env["HOME"] = self._tmp_home
        env["CLAUDE_PROJECT_DIR"] = PROJECT_ROOT
        cmd = [
            "node", ORCHESTRATOR, "record-usage",
            "--role", "developer",
            "--trigger", "natural",
            "--task", "test codex token tracking",
        ] + list(extra_args)
        return subprocess.run(
            cmd, capture_output=True, text=True, env=env, cwd=PROJECT_ROOT
        )

    def test_a_codex_with_tokens_writes_total(self):
        """(a) --backend codex --tokens 1234 → usage.jsonl tokens={total:1234}。"""
        result = self._run_record_usage("--backend", "codex", "--tokens", "1234")
        self.assertEqual(result.returncode, 0, f"stderr: {result.stderr}")
        out = json.loads(result.stdout)
        self.assertEqual(out["backend"], "codex")
        self.assertEqual(out["tokens"], "captured")
        record = _read_last_usage_record(self._tmp_home)
        self.assertIsNotNone(record)
        self.assertEqual(record["backend"], "codex")
        self.assertEqual(record["tokens"], {"total": 1234})
        self.assertNotIn("note", record)

    def test_b_codex_without_tokens_marks_unavailable(self):
        """(b) --backend codex（无 --tokens）→ tokens=null + note 提示。"""
        result = self._run_record_usage("--backend", "codex")
        self.assertEqual(result.returncode, 0, f"stderr: {result.stderr}")
        out = json.loads(result.stdout)
        self.assertEqual(out["backend"], "codex")
        self.assertEqual(out["tokens"], "unavailable")
        self.assertIn("note", out)
        record = _read_last_usage_record(self._tmp_home)
        self.assertIsNone(record["tokens"])
        self.assertIn("note", record)

    def test_c_codex_tokens_zero_treated_as_null(self):
        """(c) --tokens 0 → tokens=null（无效，0 不接受）。"""
        result = self._run_record_usage("--backend", "codex", "--tokens", "0")
        self.assertEqual(result.returncode, 0, f"stderr: {result.stderr}")
        record = _read_last_usage_record(self._tmp_home)
        self.assertIsNone(record["tokens"])

    def test_d_claude_mode_ignores_tokens_arg(self):
        """(d) --backend claude --tokens 1234 → claude 路径忽略 --tokens（走 transcript 解析）。"""
        result = self._run_record_usage("--backend", "claude", "--tokens", "1234")
        self.assertEqual(result.returncode, 0, f"stderr: {result.stderr}")
        out = json.loads(result.stdout)
        self.assertEqual(out["backend"], "claude")
        # claude 路径不读 --tokens（无 from-line 时 tokens=null，与现状一致）
        record = _read_last_usage_record(self._tmp_home)
        self.assertIsNone(record["tokens"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
