#!/usr/bin/env python3
"""
Tests for rework routing fix (issue !232 Bug2, C1-C7).

Covers:
  TC1: parseReworkRouting table (doc/ux_quality → architect post-fix)
  TC2: advance code-review P0 rework end-to-end (state.pending_rework written + next_role='architect')
  TC3: dispatch-agent.js loads dispatch-rework.md (finalPrompt markers + pending_rework cleared)
  TC4: P1>2 hardcoded dimension regression (developer,不受 defaultDimension 影响)
  TC5: security dimension array target regression (targets=['architect','developer'])
  TC6: docs_mode defaultDimension switch (no dimension passed → next_role='architect')

Infrastructure: python+node hybrid (参照 test_advance_wrapper_invoked_check.py).
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
ORCHESTRATOR = os.path.join(PROJECT_ROOT, ".claude", "skills", "rd-auto", "scripts", "orchestrator.js")
WRAPPER = os.path.join(PROJECT_ROOT, ".claude", "skills", "rd-auto", "scripts", "dispatch-agent.js")
STATE_STORE = os.path.join(PROJECT_ROOT, ".claude", "skills", "rd-auto", "scripts", "lib", "state-store.js")


# ─── Node helpers ───

def _node_eval(js, env_extra=None):
    """Run node --input-type=module with given JS, return (rc, stdout, stderr)."""
    env = os.environ.copy()
    env["NODE_PATH"] = os.path.join(PROJECT_ROOT, ".claude", "skills", "rd-auto", "scripts")
    if env_extra:
        env.update(env_extra)
    result = subprocess.run(
        ["node", "--input-type=module", "-e", js],
        capture_output=True, text=True, env=env, cwd=PROJECT_ROOT,
    )
    return result.returncode, result.stdout, result.stderr


def _node_state_op(change_name, op, **kwargs):
    """通用：node 子进程操作 pipeline-state.json."""
    js = """
import { pathToFileURL } from 'node:url';
const stateStore = await import(pathToFileURL(process.env.STATE_STORE_PATH).href);
const op = process.env.OP;
const changeName = process.env.CHANGE_NAME;
if (op === 'init_at_codereview') {
  // Init flow + fast-forward to code-review phase with dispatch_history (wrapper_invoked=true)
  const flowType = process.env.FLOW_TYPE || 'development';
  const state = stateStore.stateInit(changeName, 'rework routing test', ['c1'], flowType, false, {});
  state.current_phase = 'code-review';
  if (!state.pipeline['code-review']) {
    state.pipeline['code-review'] = { status: 'pending', rd_skill: null, first_pass: null, rework_reasons: [], artifact_paths: [] };
  }
  state.pipeline['code-review'].status = 'in_progress';
  state.pipeline['code-review'].started_at = new Date().toISOString();
  // dispatch_history entry with wrapper_invoked=true so advance passes defensive check
  state.pipeline['code-review'].dispatch_history = [{
    started_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
    exit_status: 'DONE',
    wrapper_invoked: true,
  }];
  stateStore.stateSave(changeName, state);
} else if (op === 'read_pending_rework') {
  const state = stateStore.stateLoad(changeName);
  process.stdout.write(JSON.stringify({ pending_rework: state.pending_rework || null }));
}
process.stdout.write(JSON.stringify({ ok: true }));
"""
    env = os.environ.copy()
    env["STATE_STORE_PATH"] = STATE_STORE
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
    return result.stdout


def _call_advance(change_name, extra_args=None):
    """调 advance CLI，返回 (rc, stdout_obj_or_None, raw_stdout, stderr)."""
    cmd = ["node", ORCHESTRATOR, "advance", change_name, "--exit-status", "DONE"]
    if extra_args:
        cmd.extend(extra_args)
    result = subprocess.run(cmd, capture_output=True, text=True, cwd=PROJECT_ROOT)
    out = None
    if result.stdout.strip():
        try:
            out = json.loads(result.stdout)
        except json.JSONDecodeError:
            out = None
    return result.returncode, out, result.stdout, result.stderr


def _call_wrapper(change_name, env_extra=None):
    """调 dispatch-agent.js，返回 (rc, parsed_json_or_None, raw_stdout, stderr)."""
    env = os.environ.copy()
    env["CLAUDE_PROJECT_DIR"] = PROJECT_ROOT
    env["HARNESS_BACKEND"] = "claude"
    if env_extra:
        env.update(env_extra)
    result = subprocess.run(
        ["node", WRAPPER, change_name],
        capture_output=True, text=True, env=env, cwd=PROJECT_ROOT,
    )
    out = None
    if result.stdout.strip():
        try:
            out = json.loads(result.stdout)
        except json.JSONDecodeError:
            lines = [l for l in result.stdout.splitlines() if l.strip().startswith("{")]
            if lines:
                try:
                    out = json.loads(lines[-1])
                except json.JSONDecodeError:
                    out = None
    return result.returncode, out, result.stdout, result.stderr


def _read_state(change_name):
    """Read pipeline-state.json directly."""
    state_file = os.path.join(PROJECT_ROOT, ".harness", "tasks", change_name, "pipeline-state.json")
    with open(state_file) as f:
        return json.load(f)


# ─── Tests ───

class TestReworkRouting(unittest.TestCase):
    """issue !232 Bug2: rework routing C1-C7."""

    def setUp(self):
        self.change_names = []
        self.tmpdirs = []

    def tearDown(self):
        for cn in self.change_names:
            for p in [
                os.path.join(PROJECT_ROOT, ".harness", "tasks", cn),
                os.path.join(PROJECT_ROOT, ".harness", "shared-state", cn),
            ]:
                if os.path.isdir(p):
                    shutil.rmtree(p, ignore_errors=True)
        for d in self.tmpdirs:
            shutil.rmtree(d, ignore_errors=True)

    def _make_change(self, suffix=""):
        cn = f"test-rework-route-{os.getpid()}-{abs(hash(self.id()))}{suffix}"
        self.change_names.append(cn)
        return cn

    # TC1: parseReworkRouting table
    def test_tc1_parse_rework_routing_table(self):
        """TC1: parseReworkRouting returns 5 entries; doc/ux_quality→architect (post-fix C1)."""
        js = """
import { pathToFileURL } from 'node:url';
const { parseReworkRouting } = await import(pathToFileURL(process.env.TRANSITIONS_PATH).href);
const table = parseReworkRouting(process.env.RULES_PATH);
process.stdout.write(JSON.stringify(table));
"""
        env = {
            "TRANSITIONS_PATH": os.path.join(PROJECT_ROOT, ".claude", "skills", "rd-auto", "scripts", "lib", "transitions.js"),
            "RULES_PATH": os.path.join(PROJECT_ROOT, ".claude", "reference", "harness-rules.yaml"),
        }
        rc, stdout, stderr = _node_eval(js, env_extra=env)
        self.assertEqual(rc, 0, f"node failed:\nstderr={stderr}\nstdout={stdout}")
        table = json.loads(stdout)
        self.assertEqual(len(table), 5, f"routing table should have 5 entries, got {len(table)}: {table}")

        by_dim = {e["dimension"]: e["target"] for e in table}
        # C1 fix: doc/ux_quality → architect (was reviewer)
        self.assertEqual(by_dim.get("doc/ux_quality"), "architect",
                         f"C1 fix: doc/ux_quality should route to architect, got {by_dim.get('doc/ux_quality')}")
        self.assertEqual(by_dim.get("code/implementation"), "developer")
        self.assertEqual(by_dim.get("architecture/design/tech_spec"), "architect")
        self.assertEqual(by_dim.get("test/coverage"), "tester")
        self.assertEqual(by_dim.get("security"), ["architect", "developer"])

    # TC2: advance code-review P0 rework end-to-end
    def test_tc2_advance_p0_rework_routes_to_architect(self):
        """TC2: advance code-review --p0-count 1 --dimension doc/ux_quality → next_role='architect', next_rd_skill=null, pending_rework written."""
        cn = self._make_change("-tc2")
        _node_state_op(cn, "init_at_codereview", flow_type="development")

        rc, out, raw, stderr = _call_advance(cn, ["--score", "60", "--p0-count", "1", "--dimension", "doc/ux_quality"])
        self.assertEqual(rc, 0, f"advance failed:\nstderr={stderr}\nstdout={raw}")
        self.assertIsNotNone(out, f"advance output not JSON:\nstdout={raw}\nstderr={stderr}")

        self.assertEqual(out.get("next_role"), "architect",
                         f"TC2: next_role should be 'architect', got '{out.get('next_role')}'")
        self.assertIsNone(out.get("next_rd_skill"),
                           f"TC2: next_rd_skill should be null (Q2=a), got '{out.get('next_rd_skill')}'")
        self.assertEqual(out.get("next_action"), "rework")

        # state.pending_rework written
        state = _read_state(cn)
        pr = state.get("pending_rework")
        self.assertIsNotNone(pr, "TC2: state.pending_rework should be written")
        self.assertEqual(pr.get("target_role"), "architect")
        self.assertEqual(pr.get("previous_phase"), "code-review")
        self.assertIn("reason", pr)

    # TC3: dispatch-agent.js loads dispatch-rework.md
    def test_tc3_dispatch_agent_loads_rework_template(self):
        """TC3: dispatch-agent.js → finalPrompt contains <rework_notice>/read-shared-state, subagent_type='Architect', pending_rework cleared."""
        cn = self._make_change("-tc3")
        _node_state_op(cn, "init_at_codereview", flow_type="development")

        # Step 1: trigger rework (same as TC2) to set pending_rework
        rc, out, raw, stderr = _call_advance(cn, ["--score", "60", "--p0-count", "1", "--dimension", "doc/ux_quality"])
        self.assertEqual(rc, 0, f"advance (trigger rework) failed:\nstderr={stderr}")
        self.assertEqual(out.get("next_role"), "architect")

        # Verify pending_rework is set before dispatch
        state_before = _read_state(cn)
        self.assertIsNotNone(state_before.get("pending_rework"), "precondition: pending_rework should be set")

        # Step 2: call dispatch-agent.js wrapper
        rc, out, raw, stderr = _call_wrapper(cn)
        self.assertEqual(rc, 0, f"dispatch-agent.js failed:\nstderr={stderr}\nstdout={raw}")

        self.assertIsNotNone(out, f"wrapper output not JSON:\nstdout={raw}\nstderr={stderr}")
        self.assertEqual(out.get("action"), "invoke_agent_tool",
                         f"TC3: action should be invoke_agent_tool, got '{out.get('action')}'")

        aa = out.get("agent_args", {})
        self.assertEqual(aa.get("subagent_type"), "Architect",
                         f"TC3: subagent_type should be 'Architect', got '{aa.get('subagent_type')}'")

        prompt = aa.get("prompt", "")
        self.assertIn("<rework_notice>", prompt, "TC3: finalPrompt should contain <rework_notice>")
        self.assertIn("read-shared-state", prompt, "TC3: finalPrompt should contain read-shared-state instruction")
        # C4.1 正则覆盖率：多行三元占位符必须被替换（无 {pua_debugging_required 残留）
        self.assertNotIn("{pua_debugging_required", prompt,
                         "TC3: finalPrompt should not contain unresolved {pua_debugging_required} placeholder")

        # Step 3: pending_rework cleared after dispatch (Q3=a)
        state_after = _read_state(cn)
        self.assertIsNone(state_after.get("pending_rework"),
                          "TC3: pending_rework should be null after dispatch-agent mark-start")

    # TC3 regression: non-rework dispatch does NOT load rework template
    def test_tc3b_non_rework_no_rework_template(self):
        """TC3b (回归): dp.is_rework=false → finalPrompt does NOT contain rework markers."""
        cn = self._make_change("-tc3b")
        _node_state_op(cn, "init_at_codereview", flow_type="development")

        # No advance → no pending_rework → is_rework=false
        state = _read_state(cn)
        self.assertIsNone(state.get("pending_rework"), "precondition: pending_rework should be null")

        rc, out, raw, stderr = _call_wrapper(cn)
        self.assertEqual(rc, 0, f"dispatch-agent.js failed:\nstderr={stderr}\nstdout={raw}")
        self.assertIsNotNone(out, f"wrapper output not JSON:\nstdout={raw}")

        # code-review phase dispatches Reviewer (not rework)
        aa = out.get("agent_args", {})
        prompt = aa.get("prompt", "")
        self.assertNotIn("<rework_notice>", prompt,
                         "TC3b: non-rework finalPrompt should NOT contain <rework_notice>")
        self.assertNotIn("read-shared-state", prompt.split("<rework_notice>")[0] if "<rework_notice>" in prompt else prompt,
                         "TC3b: non-rework finalPrompt should NOT contain read-shared-state from rework template")

    # TC4: P1>2 hardcoded dimension regression
    def test_tc4_p1_over_2_hardcoded_developer(self):
        """TC4: advance --score 85 --p1-count 3 → next_role='developer' (hardcoded 'code/implementation' at advance.js:582)."""
        cn = self._make_change("-tc4")
        _node_state_op(cn, "init_at_codereview", flow_type="development")

        rc, out, raw, stderr = _call_advance(cn, ["--score", "85", "--p1-count", "3"])
        self.assertEqual(rc, 0, f"advance failed:\nstderr={stderr}\nstdout={raw}")
        self.assertIsNotNone(out, f"advance output not JSON:\nstdout={raw}")

        self.assertEqual(out.get("next_role"), "developer",
                         f"TC4: next_role should be 'developer' (hardcoded code/implementation), got '{out.get('next_role')}'")
        reason = out.get("reason", "")
        self.assertIn("P1 count 3 > 2", reason,
                      f"TC4: reason should mention 'P1 count 3 > 2', got: {reason}")

    # TC5: security dimension array target regression
    def test_tc5_security_dimension_array_target(self):
        """TC5: security dimension → routeRework targets=['architect','developer']; buildReworkResponse next_role='architect' (targets[0])."""
        # Part A: routeRework returns array targets
        js = """
import { pathToFileURL } from 'node:url';
const { routeRework } = await import(pathToFileURL(process.env.TRANSITIONS_PATH).href);
const state = { rework_count: { architect: 0, developer: 0, tester: 0, reviewer: 0 } };
const result = routeRework(state, 'security', process.env.RULES_PATH);
process.stdout.write(JSON.stringify(result));
"""
        env = {
            "TRANSITIONS_PATH": os.path.join(PROJECT_ROOT, ".claude", "skills", "rd-auto", "scripts", "lib", "transitions.js"),
            "RULES_PATH": os.path.join(PROJECT_ROOT, ".claude", "reference", "harness-rules.yaml"),
        }
        rc, stdout, stderr = _node_eval(js, env_extra=env)
        self.assertEqual(rc, 0, f"node routeRework failed:\nstderr={stderr}")
        result = json.loads(stdout)
        self.assertEqual(result.get("targets"), ["architect", "developer"],
                         f"TC5: security targets should be ['architect','developer'], got {result.get('targets')}")
        self.assertFalse(result.get("unknown_dimension"), "TC5: security should not be unknown_dimension")

        # Part B: advance with --dimension security → next_role='architect' (targets[0])
        cn = self._make_change("-tc5")
        _node_state_op(cn, "init_at_codereview", flow_type="development")
        rc, out, raw, stderr = _call_advance(cn, ["--score", "60", "--p0-count", "1", "--dimension", "security"])
        self.assertEqual(rc, 0, f"advance failed:\nstderr={stderr}\nstdout={raw}")
        self.assertEqual(out.get("next_role"), "architect",
                         f"TC5: next_role should be 'architect' (targets[0]), got '{out.get('next_role')}'")

    # TC6: docs_mode defaultDimension switch
    def test_tc6_docs_mode_default_dimension_architect(self):
        """TC6: docs_mode=true + advance --score 60 (no dimension) → next_role='architect' (defaultDimension='doc/ux_quality' + C1 fix)."""
        cn = self._make_change("-tc6")
        _node_state_op(cn, "init_at_codereview", flow_type="docs")

        # Verify docs_mode is set
        state = _read_state(cn)
        self.assertTrue(state.get("docs_mode"), "precondition: docs_mode should be true")

        # score 60 < debateTrigger(75) → rework; no dimension → defaultDimension='doc/ux_quality' → architect
        rc, out, raw, stderr = _call_advance(cn, ["--score", "60"])
        self.assertEqual(rc, 0, f"advance failed:\nstderr={stderr}\nstdout={raw}")
        self.assertIsNotNone(out, f"advance output not JSON:\nstdout={raw}")

        self.assertEqual(out.get("next_role"), "architect",
                         f"TC6: docs_mode defaultDimension should route to architect, got '{out.get('next_role')}'")
        self.assertEqual(out.get("next_action"), "rework")

    # TC7: unknown dimension triggers escalate_to_pm (regression for S3 precondition)
    def test_tc7_unknown_dimension_escalates(self):
        """TC7: abbreviated dimension like 'code' (not 'code/implementation') → unknown_dimension → escalate_to_pm."""
        cn = self._make_change("-tc7")
        _node_state_op(cn, "init_at_codereview", flow_type="development")

        rc, out, raw, stderr = _call_advance(cn, ["--score", "60", "--p0-count", "1", "--dimension", "code"])
        self.assertEqual(rc, 0, f"advance failed:\nstderr={stderr}\nstdout={raw}")
        self.assertIsNotNone(out, f"advance output not JSON:\nstdout={raw}")

        # 'code' doesn't match 'code/implementation' (S3: no fuzzy match) → unknown_dimension → escalate
        self.assertTrue(out.get("needs_pm"),
                        f"TC7: abbreviated dimension should escalate to PM, got needs_pm={out.get('needs_pm')}")
        self.assertEqual(out.get("next_action"), "escalate_to_pm")


if __name__ == "__main__":
    unittest.main(verbosity=2)
