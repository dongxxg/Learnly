#!/usr/bin/env python3
"""
Tests for cmdComplete shared-state retention (Phase 3a / task 4.3)

背景：
  cmdComplete 在 pipeline 收口时曾递归删除 `.harness/shared-state/<change>/`，
  把 codex-logs/concerns.json/shared-decisions.json 全部清掉，
  事后审计无法回溯（Phase 3a 4b 阻断点）。

修复：
  移除 rmSync(sharedDir) 调用；cmdComplete 输出 shared_state_retained:true；
  shared-state 清理归属 archive 流程独立设计。

测试：
  起 fake change（含 shared-state/<change>/codex-logs/ + concerns.json），
  调 cmdComplete，断言 cmdComplete 返回后两文件仍存在 + 输出含 shared_state_retained:true。
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


class TestCmdCompleteNoPurgeSharedState(unittest.TestCase):
    """Phase 3a: cmdComplete 不删除 shared-state 目录。"""

    def setUp(self):
        if not os.path.exists(os.path.join(PROJECT_ROOT, ".claude", "skills", "rd-auto", "scripts", "orchestrator.js")):
            self.skipTest("orchestrator.js not found")

        # 创建临时 change 目录与 shared-state 目录
        self.tmp_change = f"test-complete-purge-{os.getpid()}-{abs(hash(self.id()))}"
        self.tasks_dir = os.path.join(PROJECT_ROOT, ".harness", "tasks")
        self.state_dir = os.path.join(PROJECT_ROOT, ".harness", "shared-state", self.tmp_change)
        self.codex_logs_dir = os.path.join(self.state_dir, "codex-logs")
        self.concerns_path = os.path.join(self.state_dir, "concerns.json")

        # 清理潜在残留
        for p in [self.state_dir,
                  os.path.join(self.tasks_dir, self.tmp_change)]:
            if os.path.exists(p):
                shutil.rmtree(p, ignore_errors=True)

        # 创建 shared-state + codex-logs + concerns.json
        os.makedirs(self.codex_logs_dir, exist_ok=True)
        with open(os.path.join(self.codex_logs_dir, "developer-1-20260705120000.txt"), "w") as f:
            f.write("# fake codex log\n## raw_output\nfake output\n")
        with open(self.concerns_path, "w") as f:
            json.dump({"concerns": []}, f)

    def tearDown(self):
        for p in [self.state_dir,
                  os.path.join(self.tasks_dir, self.tmp_change)]:
            if os.path.exists(p):
                shutil.rmtree(p, ignore_errors=True)

    def _init_change_via_node(self):
        """通过 stateInit 创建一个 fake change 的 pipeline-state.json（quick flow）."""
        js = """
import { pathToFileURL } from 'node:url';
const stateStore = await import(pathToFileURL(process.env.STATE_STORE_PATH).href);
const state = stateStore.stateInit(
  process.env.CHANGE_NAME,
  'test change for cmdComplete no purge',
  ['criterion 1'],
  'quick',           // flow_type
  false,             // hotfix_mode
  {},                // intent
);
state.current_phase = 'complete';  // 直接跳到 complete 入口（让 cmdComplete 能跑）
state.completed_at = new Date().toISOString();
stateStore.stateSave(process.env.CHANGE_NAME, state);
process.stdout.write(JSON.stringify({ ok: true }));
"""
        env = os.environ.copy()
        env["STATE_STORE_PATH"] = os.path.join(
            PROJECT_ROOT, ".claude", "skills", "rd-auto", "scripts", "lib", "state-store.js"
        )
        env["CHANGE_NAME"] = self.tmp_change
        result = subprocess.run(
            ["node", "--input-type=module", "-e", js],
            capture_output=True, text=True, env=env, cwd=PROJECT_ROOT,
        )
        if result.returncode != 0:
            raise AssertionError(
                f"stateInit failed rc={result.returncode}:\n"
                f"stderr={result.stderr}\nstdout={result.stdout}"
            )

    def test_complete_does_not_purge_shared_state(self):
        """cmdComplete 调用后 shared-state/codex-logs/ + concerns.json 仍存在。"""
        self._init_change_via_node()

        # 调 cmdComplete
        result = subprocess.run(
            ["node", ".claude/skills/rd-auto/scripts/orchestrator.js",
             "complete", self.tmp_change],
            capture_output=True, text=True, cwd=PROJECT_ROOT,
        )
        if result.returncode != 0:
            self.fail(f"cmdComplete failed rc={result.returncode}:\n"
                      f"stderr={result.stderr}\nstdout={result.stdout}")

        # 断言 shared-state 目录存在
        self.assertTrue(os.path.isdir(self.state_dir),
                        f"shared-state 目录应保留：{self.state_dir}")
        # 断言 codex-logs 文件存在
        codex_logs_files = os.listdir(self.codex_logs_dir)
        self.assertGreater(len(codex_logs_files), 0, "codex-logs 文件应保留")
        # 断言 concerns.json 存在
        self.assertTrue(os.path.isfile(self.concerns_path),
                        f"concerns.json 应保留：{self.concerns_path}")
        # 断言 cmdComplete 输出含 shared_state_retained:true
        try:
            output = json.loads(result.stdout)
        except json.JSONDecodeError:
            self.fail(f"cmdComplete 输出非 JSON：{result.stdout}")
        self.assertEqual(output.get("shared_state_retained"), True,
                         f"cmdComplete 应输出 shared_state_retained:true, got: {output}")


if __name__ == "__main__":
    unittest.main(verbosity=2)
