#!/usr/bin/env python3
"""
Tests for orchestrator.js dispatch-prompt output backend field (tasks 2.3)

覆盖：
  - HARNESS_BACKEND=codex → backend.type === "codex"
  - HARNESS_BACKEND=claude（或未设置）→ backend.type === "claude"
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, "..", "..", "..", ".."))
ORCH = os.path.join(PROJECT_ROOT, ".claude", "skills", "rd-auto", "scripts", "orchestrator.js")


def _run(args, env_extra=None, cwd=None):
    env = os.environ.copy()
    if env_extra:
        env.update(env_extra)
    return subprocess.run(
        ["node", ORCH] + args,
        capture_output=True,
        text=True,
        env=env,
        cwd=cwd or PROJECT_ROOT,
    )


def _init_change(change_name):
    """初始化一个临时 change。返回 (cwd, change_name)。"""
    cwd = tempfile.mkdtemp(prefix="rd-dispatch-prompt-test-")
    # 在 cwd 下建立 .harness/.claude 的最小目录结构，
    # 通过 PROJECT_ROOT=cwd + 在那里跑 orchestrator
    # 但 orchestrator 走 PROJECT_ROOT 自动发现逻辑——简化：直接在主项目里建临时 change
    return None, change_name


class TestDispatchPromptIncludesBackend(unittest.TestCase):
    """tasks 2.3: dispatch-prompt 输出含 backend.type 字段"""

    @classmethod
    def setUpClass(cls):
        cls.change_name = "test-backend-field-dispatch"
        cls.cwd = PROJECT_ROOT
        # 在主项目里初始化临时 change
        result = _run([
            "init", cls.change_name,
            "--flow-type", "development",
            "--intent-json",
            json.dumps({
                "task_type": "feature",
                "intent_category": "feature_dev",
                "confidence": 0.9,
                "affected_files": ["x.py"],
                "complexity_hint": "M",
            }),
            "--criteria", "test backend field",
        ])
        if result.returncode != 0:
            raise RuntimeError(
                f"init failed rc={result.returncode}\n"
                f"stderr={result.stderr}\nstdout={result.stdout}"
            )

    @classmethod
    def tearDownClass(cls):
        # 清理临时 change
        for p in (
            os.path.join(PROJECT_ROOT, ".harness", "spec", "changes", cls.change_name),
            os.path.join(PROJECT_ROOT, ".harness", "tasks", cls.change_name),
        ):
            if os.path.isdir(p):
                shutil.rmtree(p, ignore_errors=True)

    def _dispatch(self, harness_backend=None):
        env_extra = {}
        if harness_backend is not None:
            env_extra["HARNESS_BACKEND"] = harness_backend
        else:
            # 显式 unset
            env_extra.pop("HARNESS_BACKEND", None)
        # 用 env 复制后删除
        result = subprocess.run(
            ["node", ORCH, "dispatch-prompt", self.change_name],
            capture_output=True,
            text=True,
            env={**{k: v for k, v in os.environ.items() if k != "HARNESS_BACKEND"}, **env_extra},
            cwd=PROJECT_ROOT,
        )
        self.assertEqual(result.returncode, 0, f"stderr={result.stderr}")
        # 找 JSON 输出
        out = result.stdout
        # output 直接是 JSON（_safeBackendInfo 调 output()）
        try:
            return json.loads(out)
        except json.JSONDecodeError:
            # 有时 stdout 混杂了 debugLog，找最后一行 JSON
            for line in reversed(out.splitlines()):
                line = line.strip()
                if line.startswith("{"):
                    return json.loads(line)
            raise

    def test_codex_backend_field(self):
        """HARNESS_BACKEND=codex → backend.type==='codex'."""
        result = self._dispatch("codex")
        self.assertIn("backend", result)
        self.assertEqual(result["backend"]["type"], "codex")

    def test_claude_backend_field(self):
        """HARNESS_BACKEND=claude → backend.type==='claude'."""
        result = self._dispatch("claude")
        self.assertIn("backend", result)
        self.assertEqual(result["backend"]["type"], "claude")

    @unittest.skipIf(shutil.which("codex") is not None,
                     "本机装了 codex CLI，detectBackend() 会优先探测到 codex；"
                     "此测试验证的是 'codex 不可用时默认 claude' 的场景")
    def test_unspecified_backend_defaults_claude(self):
        """HARNESS_BACKEND 未设置 → backend.type==='claude'."""
        result = self._dispatch(None)
        self.assertIn("backend", result)
        self.assertEqual(result["backend"]["type"], "claude")

    def test_backend_field_structure(self):
        """backend 字段结构 = {type, name}."""
        result = self._dispatch("claude")
        backend = result["backend"]
        self.assertIn("type", backend)
        self.assertIn("name", backend)
        self.assertIsInstance(backend["type"], str)
        self.assertIsInstance(backend["name"], str)


if __name__ == "__main__":
    unittest.main(verbosity=2)
