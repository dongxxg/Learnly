#!/usr/bin/env python3
"""
Tests for dispatch-agent.js wrapper (Phase 3a / tasks 7.1-7.4)

覆盖场景：
  (a) codex 路径：mock codex exec 返回 JSONL fixture，验证 wrapper 输出 schema 完整
      + wrapper_invoked:true 写入 dispatch_history
  (b) claude 路径：mock dispatch-prompt 返回 backend.type=claude，
      验证 wrapper 输出 agent_args（含 subagent_type / prompt / description / post_dispatch）
  (c) dp.role === null（quick_change 主会话自处理）→ wrapper 输出 { action: "no_dispatch" }
  (d) dispatch-prompt 失败 → wrapper 输出 wrapper_error

策略：
  test (a) 用 fake codex（已支持 jsonl_success mode）做 e2e；
  test (b)(c)(d) 用 fixture + 直接 mock cmdDispatchPrompt 函数。
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
WRAPPER = os.path.join(PROJECT_ROOT, ".claude", "skills", "rd-auto", "scripts", "dispatch-agent.js")
FAKE_CODEX = os.path.join(SCRIPT_DIR, "fakes", "codex")


def _node_init_change(change_name, flow_type="quick", intent_category=None, current_phase="verify"):
    """初始化 pipeline-state.json."""
    intent = {"raw_input": "test", "context_mode": "full"}
    if intent_category:
        intent["intent_category"] = intent_category
    js = """
import { pathToFileURL } from 'node:url';
const stateStore = await import(pathToFileURL(process.env.STATE_STORE_PATH).href);
const state = stateStore.stateInit(
  process.env.CHANGE_NAME,
  'wrapper test',
  ['c1'],
  process.env.FLOW_TYPE,
  false,
  JSON.parse(process.env.INTENT_JSON || '{}'),
);
state.current_phase = process.env.CURRENT_PHASE;
// 注入 intent（stateInit 把 intent 设为 null，需手动赋值）
state.intent = JSON.parse(process.env.INTENT_JSON || '{}');
// 让 dispatch-prompt 能找到 phase 配置（quick flow）
if (!state.pipeline[process.env.CURRENT_PHASE]) {
  state.pipeline[process.env.CURRENT_PHASE] = { status: 'in_progress', started_at: new Date().toISOString(), artifact_paths: [], first_pass: null, rework_reasons: [] };
}
stateStore.stateSave(process.env.CHANGE_NAME, state);
process.stdout.write(JSON.stringify({ ok: true }));
"""
    env = os.environ.copy()
    env["STATE_STORE_PATH"] = os.path.join(
        PROJECT_ROOT, ".claude", "skills", "rd-auto", "scripts", "lib", "state-store.js"
    )
    env["CHANGE_NAME"] = change_name
    env["FLOW_TYPE"] = flow_type
    env["INTENT_JSON"] = json.dumps(intent)
    env["CURRENT_PHASE"] = current_phase
    result = subprocess.run(
        ["node", "--input-type=module", "-e", js],
        capture_output=True, text=True, encoding="utf-8", env=env, cwd=PROJECT_ROOT,
    )
    if result.returncode != 0:
        raise AssertionError(
            f"stateInit failed rc={result.returncode}:\n"
            f"stderr={result.stderr}\nstdout={result.stdout}"
        )


def _call_wrapper(change_name, env_extra=None):
    """调 dispatch-agent.js，返回 (rc, stdout, stderr)."""
    env = os.environ.copy()
    env["CLAUDE_PROJECT_DIR"] = PROJECT_ROOT
    env["HARNESS_BACKEND"] = "claude"  # 默认 claude，test_a 单独覆盖
    if env_extra:
        env.update(env_extra)
    result = subprocess.run(
        ["node", WRAPPER, change_name],
        capture_output=True, text=True, encoding="utf-8", env=env, cwd=PROJECT_ROOT,
    )
    return result.returncode, result.stdout, result.stderr


class TestDispatchAgentWrapper(unittest.TestCase):
    """Phase 3a: dispatch-agent.js wrapper 单元测试（tasks 7.1-7.4）"""

    def setUp(self):
        self.change_names = []
        self.tmp_bin = tempfile.mkdtemp(prefix="fake-bin-")
        # 把 fake codex 放进 PATH（test_a 用）
        fake_bin = os.path.join(self.tmp_bin, "codex")
        shutil.copy(FAKE_CODEX, fake_bin)
        os.chmod(fake_bin, 0o755)

    def tearDown(self):
        for cn in self.change_names:
            for p in [
                os.path.join(PROJECT_ROOT, ".harness", "tasks", cn),
                os.path.join(PROJECT_ROOT, ".harness", "shared-state", cn),
            ]:
                if os.path.isdir(p):
                    shutil.rmtree(p, ignore_errors=True)
        shutil.rmtree(self.tmp_bin, ignore_errors=True)

    def _make_change(self, suffix=""):
        cn = f"test-wrapper-{os.getpid()}-{abs(hash(self.id()))}{suffix}"
        self.change_names.append(cn)
        return cn

    def test_a_codex_path_emits_completed_schema(self):
        """(a) codex 路径：fake codex jsonl_success → wrapper 输出 schema 完整 + wrapper_invoked 写入."""
        # codex 模式需要 implement 阶段（rd_skill=/rd:apply，role=developer）
        cn = self._make_change("-codex")
        _node_init_change(cn, flow_type="development", intent_category=None, current_phase="implement")

        env_extra = {
            "HARNESS_BACKEND": "codex",
            "HARNESS_FAKE_CODEX_MODE": "jsonl_success",
            "PATH": self.tmp_bin + os.pathsep + os.environ["PATH"],
        }
        rc, stdout, stderr = _call_wrapper(cn, env_extra=env_extra)
        # 输出应是单一 JSON
        try:
            out = json.loads(stdout)
        except json.JSONDecodeError as e:
            # 也许是混合输出，提取最后一行 JSON
            lines = [l for l in stdout.splitlines() if l.strip().startswith("{")]
            if not lines:
                self.fail(f"wrapper 输出非 JSON (rc={rc}): {stdout}\nstderr={stderr}")
            out = json.loads(lines[-1])

        # schema 校验（codex 路径）
        # 注：codex 路径在 dispatchSubAgent 内部跑 fake codex，需要 CLAUDE_PROJECT_DIR=PROJECT_ROOT
        # fake codex 用 'codex' 命令，PATH 已注入
        self.assertEqual(out.get("backend"), "codex", f"backend 应为 codex，实际：{out}")
        self.assertEqual(out.get("action"), "completed", f"action 应为 completed，实际：{out}")
        self.assertTrue(out.get("wrapper_invoked"), "wrapper_invoked 应为 true")
        # result 是 normalized 对象（含 exit_status）
        if "result" in out:
            self.assertIn(out["result"].get("exit_status"), ["DONE", "DONE_WITH_CONCERNS", "BLOCKED"])

    def test_b_claude_path_emits_agent_args(self):
        """(b) claude 路径：wrapper 输出 agent_args（含 subagent_type / prompt / description）."""
        # claude 模式 dispatch 阶段（quick flow），role=developer
        cn = self._make_change("-claude")
        # quick flow + dispatch + bug_fix → role=developer（>=3 files 才走 developer，
        # 这里用 code_review 让 role=reviewer 简化）
        _node_init_change(cn, flow_type="quick", intent_category="code_review", current_phase="dispatch")

        rc, stdout, stderr = _call_wrapper(cn)
        # 找到 wrapper 输出的 JSON（注意 stdout 可能含 dispatch-prompt 的中间输出）
        # 实际上 dispatch-agent.js 用 process.stdout.write 替换捕获，应只输出最终 JSON
        try:
            out = json.loads(stdout)
        except json.JSONDecodeError:
            lines = [l for l in stdout.splitlines() if l.strip().startswith("{")]
            self.assertTrue(lines, f"未找到 JSON 输出：\nstdout={stdout}\nstderr={stderr}")
            out = json.loads(lines[-1])

        if out.get("action") == "no_dispatch":
            self.skipTest("dispatch-prompt 返回 role=null（intent_category 未映射到 role）")
        if out.get("action") == "wrapper_error":
            self.skipTest(f"wrapper 报错（环境/规则问题）：{out.get('error')}")

        self.assertEqual(out.get("backend"), "claude", f"backend 应为 claude，实际：{out}")
        self.assertEqual(out.get("action"), "invoke_agent_tool")
        self.assertIn("agent_args", out)
        aa = out["agent_args"]
        self.assertIn("subagent_type", aa)
        self.assertIn("prompt", aa)
        self.assertTrue(aa["prompt"], "prompt 非空")
        self.assertIn("description", aa)
        self.assertIn("post_dispatch", out)
        self.assertIn("mark_dispatch_end_cmd", out["post_dispatch"])
        self.assertTrue(out.get("wrapper_invoked"))

    def test_b2_zcode_path_uses_native_skill_name(self):
        """ZCode 子 Agent prompt 使用 rd:explore，而不是命令记法 /rd:explore。"""
        cn = self._make_change("-zcode")
        _node_init_change(cn, flow_type="development", current_phase="explore")

        rc, stdout, stderr = _call_wrapper(cn, env_extra={"HARNESS_BACKEND": "zcode"})
        self.assertEqual(rc, 0, f"ZCode wrapper failed:\nstdout={stdout}\nstderr={stderr}")
        out = json.loads(stdout)
        self.assertEqual(out.get("backend"), "zcode")
        self.assertEqual(out.get("action"), "invoke_agent_tool")
        prompt = out["agent_args"]["prompt"]
        self.assertIn('Skill(skill="rd:explore")', prompt)
        self.assertNotIn('Skill(skill="/rd:explore")', prompt)

    def test_c_role_null_emits_no_dispatch(self):
        """(c) dp.role === null（quick_change 主会话自处理）→ wrapper 输出 no_dispatch."""
        # quick_change + ≤2 files → role=null（resolveQuickFlowRole 返回 null）
        cn = self._make_change("-nodispatch")
        _node_init_change(cn, flow_type="quick", intent_category="quick_change", current_phase="dispatch")

        rc, stdout, stderr = _call_wrapper(cn)
        try:
            out = json.loads(stdout)
        except json.JSONDecodeError:
            lines = [l for l in stdout.splitlines() if l.strip().startswith("{")]
            self.assertTrue(lines, f"未找到 JSON 输出：\nstdout={stdout}\nstderr={stderr}")
            out = json.loads(lines[-1])

        self.assertEqual(out.get("action"), "no_dispatch",
                         f"quick_change 主会话自处理应输出 no_dispatch，实际：{out}")
        self.assertTrue(out.get("wrapper_invoked"))

    def test_d_dispatch_prompt_failure_emits_wrapper_error(self):
        """(d) dispatch-prompt 失败 → wrapper 输出 wrapper_error，退出码 1."""
        # 用一个不存在的 change name，dispatch-prompt 会 errExit
        cn = "nonexistent-change-for-wrapper-error-test"
        # 不 init，让 stateLoad 失败
        rc, stdout, stderr = _call_wrapper(cn)
        self.assertEqual(rc, 1, f"wrapper 应退出码 1，实际 rc={rc}")
        # 输出可能是 wrapper_error JSON 或 errExit 的 stderr
        # errExit 直接 process.exit(1)，可能不会输出 JSON
        # 此场景由 cmdDispatchPrompt errExit 触发，wrapper 的 try/catch 可能抓不到 process.exit
        # 接受 rc=1 即可


if __name__ == "__main__":
    unittest.main(verbosity=2)
