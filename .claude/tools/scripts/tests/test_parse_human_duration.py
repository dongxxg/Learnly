#!/usr/bin/env python3
"""
Tests for parseHumanDuration / resolveTimeoutMs (tasks 4.2)

覆盖：
  - "10m" → 600000
  - "1h" → 3600000
  - "30s" → 30000
  - 裸数字 "600" → 600
  - null/空 → null
  - 非法字符串 → null
  - resolveTimeoutMs(implement) → 1800000（30m，来自 rules dispatch.timeout.overrides）
  - resolveTimeoutMs(null/unknown) → 600000（10m default）
"""

import json
import os
import subprocess
import sys
import unittest

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, "..", "..", "..", ".."))
CODEX_BACKEND = os.path.join(PROJECT_ROOT, ".claude", "backends", "codex-backend.js")
RULES_YAML = os.path.join(PROJECT_ROOT, ".claude", "reference", "harness-rules.yaml")
YAML_PARSER = os.path.join(PROJECT_ROOT, ".claude", "skills", "rd-auto", "scripts", "lib", "yaml-parser.js")


def call_helper(fn_name, arg):
    js = f"""
import {{ pathToFileURL }} from 'node:url';
const mod = await import(pathToFileURL(process.env.MODULE_PATH).href);
const arg = JSON.parse(process.env.ARG || 'null');
const out = mod.{fn_name}(arg);
process.stdout.write(JSON.stringify(out));
"""
    env = os.environ.copy()
    env["MODULE_PATH"] = CODEX_BACKEND
    env["ARG"] = json.dumps(arg)
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
    out = result.stdout.strip()
    return json.loads(out) if out else None


def call_resolve_timeout(phase):
    js = """
import { pathToFileURL } from 'node:url';
const mod = await import(pathToFileURL(process.env.MODULE_PATH).href);
const out = mod.resolveTimeoutMs(process.env.PHASE || null, process.env.RULES_PATH);
process.stdout.write(JSON.stringify(out));
"""
    env = os.environ.copy()
    env["MODULE_PATH"] = CODEX_BACKEND
    env["RULES_PATH"] = RULES_YAML
    env["PHASE"] = phase or ""
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
    return int(result.stdout.strip())


class TestParseHumanDuration(unittest.TestCase):

    def test_minutes(self):
        self.assertEqual(call_helper("parseHumanDuration", "10m"), 600000)

    def test_hours(self):
        self.assertEqual(call_helper("parseHumanDuration", "1h"), 3600000)

    def test_seconds(self):
        self.assertEqual(call_helper("parseHumanDuration", "30s"), 30000)

    def test_milliseconds_default(self):
        self.assertEqual(call_helper("parseHumanDuration", "600"), 600)

    def test_decimal_minutes(self):
        self.assertEqual(call_helper("parseHumanDuration", "1.5m"), 90000)

    def test_null_returns_null(self):
        self.assertIsNone(call_helper("parseHumanDuration", None))

    def test_empty_string_returns_null(self):
        self.assertIsNone(call_helper("parseHumanDuration", ""))

    def test_invalid_string_returns_null(self):
        self.assertIsNone(call_helper("parseHumanDuration", "abc"))

    def test_numeric_input_passthrough(self):
        self.assertEqual(call_helper("parseHumanDuration", 5000), 5000)


class TestResolveTimeoutMs(unittest.TestCase):

    def test_implement_uses_30m_override(self):
        """implement 阶段用 30m override。"""
        self.assertEqual(call_resolve_timeout("implement"), 1800000)

    def test_explore_uses_15m_override(self):
        """explore 阶段用 15m override。"""
        self.assertEqual(call_resolve_timeout("explore"), 900000)

    def test_code_review_uses_10m_override(self):
        """code-review 阶段用 10m override。"""
        self.assertEqual(call_resolve_timeout("code-review"), 600000)

    def test_unknown_phase_falls_back_to_default(self):
        """未配置 phase 走 default 10m。"""
        self.assertEqual(call_resolve_timeout("smoke"), 600000)

    def test_null_phase_uses_default(self):
        """phase=null 走 default。"""
        self.assertEqual(call_resolve_timeout(None), 600000)

    def test_design_review_uses_15m_override(self):
        """design-review 阶段用 15m override（防御 mapping 回归为 list）。"""
        self.assertEqual(call_resolve_timeout("design-review"), 900000)

    def test_propose_uses_15m_override(self):
        """propose 阶段用 15m override（覆盖更多 phase）。"""
        self.assertEqual(call_resolve_timeout("propose"), 900000)


class TestDispatchTimeoutConfigShape(unittest.TestCase):
    """
    P2-001 防御：harness-rules.yaml 的 dispatch.timeout 必须是 mapping（带
    `default` + `overrides`），而非 `- timeout:` 数组项语法。
    依赖隐式折叠会让 strict YAML 解析器解析为 `[{timeout: ...}]`，
    导致 `loadDispatchTimeouts` 的 `yaml?.dispatch?.timeout` 变 undefined。
    """

    def _parse_rules(self):
        js = """
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
const mod = await import(pathToFileURL(process.env.YAML_PARSER).href);
const text = readFileSync(process.env.RULES_PATH, 'utf8');
const out = mod.parseYaml(text);
process.stdout.write(JSON.stringify(out));
"""
        env = os.environ.copy()
        env["YAML_PARSER"] = YAML_PARSER
        env["RULES_PATH"] = RULES_YAML
        result = subprocess.run(
            ["node", "--input-type=module", "-e", js],
            capture_output=True, text=True, env=env, cwd=PROJECT_ROOT,
        )
        if result.returncode != 0:
            raise AssertionError(
                f"node failed rc={result.returncode}:\nstderr={result.stderr}\nstdout={result.stdout}"
            )
        return json.loads(result.stdout.strip())

    def test_dispatch_timeout_is_mapping_not_array(self):
        """dispatch.timeout 必须是 mapping（dict），不能是数组。"""
        rules = self._parse_rules()
        self.assertIn("dispatch", rules, "rules.dispatch 段必须存在")
        self.assertIsInstance(rules["dispatch"], dict,
                             f"rules.dispatch 必须是 mapping，实际: {type(rules['dispatch']).__name__}")
        self.assertIn("timeout", rules["dispatch"],
                      "rules.dispatch.timeout 段必须存在")
        timeout_cfg = rules["dispatch"]["timeout"]
        self.assertIsInstance(timeout_cfg, dict,
                             f"dispatch.timeout 必须是 mapping（带 default + overrides），"
                             f"实际类型: {type(timeout_cfg).__name__}，"
                             f"实际值: {timeout_cfg!r}")
        self.assertNotIsInstance(timeout_cfg, list,
                                 "dispatch.timeout 不得为数组（防止 - timeout: 数组项语法）")

    def test_dispatch_timeout_has_default_and_overrides(self):
        """dispatch.timeout mapping 必含 default + overrides 两个键。"""
        rules = self._parse_rules()
        timeout_cfg = rules["dispatch"]["timeout"]
        self.assertIn("default", timeout_cfg, "dispatch.timeout.default 必须存在")
        self.assertIn("overrides", timeout_cfg, "dispatch.timeout.overrides 必须存在")
        self.assertIsInstance(timeout_cfg["overrides"], dict,
                             f"overrides 必须是 mapping，实际: {type(timeout_cfg['overrides']).__name__}")


if __name__ == "__main__":
    unittest.main(verbosity=2)
