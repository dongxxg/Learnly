#!/usr/bin/env python3
"""
Tests for advance wrapper_invoked defensive check (Phase 3a / task 7.10)

背景：
  Phase 3a 引入 dispatch-agent.js wrapper 作为主会话 dispatch 强制入口。
  wrapper 在 mark-dispatch --start 后立即 read-modify-write pipeline-state.json，
  给当前 phase 的 dispatch_history 末尾条目追加 wrapper_invoked:true 字段。
  advance 命令入口校验该字段，缺失（且非 undefined）时拒绝推进。

测试：
  1. 末尾条目 wrapper_invoked === false → advance 拒绝推进 + 错误消息含 "bypassing is forbidden"
  2. 末尾条目 wrapper_invoked === true → advance 正常推进
  3. 末尾条目无 wrapper_invoked 字段（旧 change）→ advance 正常推进（兼容窗口，warning）
  4. dispatch_history 为空 → advance 正常推进（首次 dispatch 前）
"""

import json
import os
import shutil
import subprocess
import sys
import unittest

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, "..", "..", "..", ".."))


def _node_state_op(change_name, op, **kwargs):
    """通用：node 子进程操作 pipeline-state.json."""
    js = """
import { pathToFileURL } from 'node:url';
const stateStore = await import(pathToFileURL(process.env.STATE_STORE_PATH).href);
const op = process.env.OP;
const changeName = process.env.CHANGE_NAME;
if (op === 'init_quick') {
  const state = stateStore.stateInit(changeName, 'advance wrapper_invoked test', ['c1'], 'quick', false, {});
  state.current_phase = 'verify';  // 跳过 intake
  state.pipeline.verify = { status: 'in_progress', started_at: new Date().toISOString(), artifact_paths: [], first_pass: null, rework_reasons: [] };
  stateStore.stateSave(changeName, state);
} else if (op === 'set_last_dispatch_field') {
  const state = stateStore.stateLoad(changeName);
  const ph = state.pipeline[state.current_phase];
  if (!ph.dispatch_history) ph.dispatch_history = [];
  if (ph.dispatch_history.length === 0) {
    ph.dispatch_history.push({ started_at: new Date().toISOString(), completed_at: null, exit_status: null });
  }
  const last = ph.dispatch_history[ph.dispatch_history.length - 1];
  if (process.env.FIELD_VALUE === 'undefined') {
    delete last.wrapper_invoked;
  } else {
    last.wrapper_invoked = process.env.FIELD_VALUE === 'true';
  }
  stateStore.stateSave(changeName, state);
} else if (op === 'init_dev_implement') {
  // 初始化 development flow，current_phase=implement，含一份 dispatch_history
  const state = stateStore.stateInit(changeName, 'test', ['c1'], 'development', false, {});
  state.current_phase = 'implement';
  state.pipeline.implement = {
    status: 'in_progress',
    started_at: new Date().toISOString(),
    artifact_paths: [],
    first_pass: null,
    rework_reasons: [],
    dispatch_history: [{
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      exit_status: 'DONE',
    }],
  };
  stateStore.stateSave(changeName, state);
}
process.stdout.write(JSON.stringify({ ok: true }));
"""
    env = os.environ.copy()
    env["STATE_STORE_PATH"] = os.path.join(
        PROJECT_ROOT, ".claude", "skills", "rd-auto", "scripts", "lib", "state-store.js"
    )
    env["CHANGE_NAME"] = change_name
    env["OP"] = op
    for k, v in kwargs.items():
        env[k.upper()] = str(v)
    result = subprocess.run(
        ["node", "--input-type=module", "-e", js],
        capture_output=True, text=True, env=env, cwd=PROJECT_ROOT,
    )
    if result.returncode != 0:
        raise AssertionError(
            f"node state op '{op}' failed rc={result.returncode}:\n"
            f"stderr={result.stderr}\nstdout={result.stdout}"
        )


def _call_advance(change_name, exit_status="DONE"):
    """调 advance CLI，返回 (rc, stdout, stderr)."""
    result = subprocess.run(
        ["node", ".claude/skills/rd-auto/scripts/orchestrator.js",
         "advance", change_name, "--exit-status", exit_status],
        capture_output=True, text=True, cwd=PROJECT_ROOT,
    )
    return result.returncode, result.stdout, result.stderr


class TestAdvanceWrapperInvokedCheck(unittest.TestCase):
    """Phase 3a: advance 校验 dispatch_history 末尾 wrapper_invoked 字段（task 7.10）"""

    def setUp(self):
        self.change_names = []

    def tearDown(self):
        for cn in self.change_names:
            change_dir = os.path.join(PROJECT_ROOT, ".harness", "tasks", cn)
            if os.path.isdir(change_dir):
                shutil.rmtree(change_dir, ignore_errors=True)

    def _make_change(self, suffix=""):
        cn = f"test-advance-wrapper-{os.getpid()}-{abs(hash(self.id()))}{suffix}"
        self.change_names.append(cn)
        return cn

    def test_01_explicit_false_rejects_advance(self):
        """末尾 wrapper_invoked === false → advance 拒绝推进，错误消息含 'bypassing is forbidden'."""
        cn = self._make_change("-false")
        _node_state_op(cn, "init_quick")
        _node_state_op(cn, "set_last_dispatch_field", field_value="false")

        rc, stdout, stderr = _call_advance(cn)
        self.assertNotEqual(rc, 0, f"advance 应失败，但 rc=0\nstdout={stdout}\nstderr={stderr}")
        combined = stdout + stderr
        self.assertIn("bypassing is forbidden", combined,
                      f"错误消息应含 'bypassing is forbidden'，实际：{combined}")

    def test_02_explicit_true_allows_advance(self):
        """末尾 wrapper_invoked === true → advance 正常推进."""
        cn = self._make_change("-true")
        _node_state_op(cn, "init_quick")
        _node_state_op(cn, "set_last_dispatch_field", field_value="true")

        rc, stdout, stderr = _call_advance(cn)
        # 注意：advance 在 quick flow verify 阶段后可能跳到 complete，
        # 但如果没有 dispatch，advance 可能在中间状态。这里只验证不阻塞 advance。
        self.assertEqual(rc, 0, f"advance 应成功（wrapper_invoked=true），但失败\nstdout={stdout}\nstderr={stderr}")

    def test_03_legacy_no_field_allows_advance(self):
        """末尾无 wrapper_invoked 字段（旧 change）→ advance 正常推进（兼容窗口）."""
        cn = self._make_change("-legacy")
        _node_state_op(cn, "init_quick")
        _node_state_op(cn, "set_last_dispatch_field", field_value="undefined")

        rc, stdout, stderr = _call_advance(cn)
        self.assertEqual(rc, 0, f"advance 应成功（兼容窗口，无 wrapper_invoked 字段），但失败\nstdout={stdout}\nstderr={stderr}")

    def test_04_empty_dispatch_history_allows_advance(self):
        """dispatch_history 为空 → advance 正常推进（首次 dispatch 前）."""
        cn = self._make_change("-empty")
        _node_state_op(cn, "init_quick")
        # 不写 dispatch_history

        rc, stdout, stderr = _call_advance(cn)
        self.assertEqual(rc, 0, f"advance 应成功（dispatch_history 为空），但失败\nstdout={stdout}\nstderr={stderr}")


if __name__ == "__main__":
    unittest.main(verbosity=2)
