#!/usr/bin/env python3
"""
Tests for CodexBackend._parseOutput JSON 尾块解析（tasks 1.7）

覆盖场景：
  (a) 标准 JSON 尾块 → DONE
  (b) 含 "Failed" 字样但 JSON=DONE → DONE（反启发式）
  (c) 无 JSON 块 → DONE_WITH_CONCERNS + concerns
  (d) 多个 JSON 块取最后一个
  (e) 裸 {...} 兜底解析

测试通过 subprocess 调 node，因为 codex-backend.js 是 ESM 模块。
"""

import json
import os
import subprocess
import sys
import unittest

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, "..", "..", "..", ".."))
CODEX_BACKEND = os.path.join(PROJECT_ROOT, ".claude", "backends", "codex-backend.js")


def call_parse_output(output_text):
    """调 CodexBackend._parseOutput 通过 node 子进程，返回解析后的 dict。"""
    node_script = f"""
import {{ pathToFileURL }} from 'node:url';
import {{ CodexBackend }} from process.env.MODULE_PATH
    .split(',')
    .map(x => x)
    .reduce((_, p) => pathToFileURL(p).href, '');
"""
    # 用更简单的方式：直接传 import.meta.url
    js = """
import { pathToFileURL } from 'node:url';
const mod = await import(pathToFileURL(process.env.MODULE_PATH).href);
const backend = new mod.CodexBackend();
const out = backend._parseOutput(process.env.PARSE_INPUT, 'developer');
process.stdout.write(JSON.stringify(out));
"""
    env = os.environ.copy()
    env["MODULE_PATH"] = CODEX_BACKEND
    env["PARSE_INPUT"] = output_text
    result = subprocess.run(
        ["node", "--input-type=module", "-e", js],
        capture_output=True,
        text=True,
        env=env,
        cwd=PROJECT_ROOT,
    )
    if result.returncode != 0:
        raise AssertionError(
            f"node subprocess failed (rc={result.returncode}):\n"
            f"stderr: {result.stderr}\nstdout: {result.stdout}"
        )
    return json.loads(result.stdout)


class TestCodexParseOutputJson(unittest.TestCase):
    """CodexBackend._parseOutput JSON 尾块解析契约（tasks 1.7）"""

    def setUp(self):
        if not os.path.exists(CODEX_BACKEND):
            self.skipTest(f"codex-backend.js not found at {CODEX_BACKEND}")

    def test_a_standard_json_fenced_block_returns_done(self):
        """(a) 标准 ```json fenced block → DONE + summary + artifacts。"""
        output = (
            "Some thinking about the task.\n"
            "I implemented feature X.\n"
            "```json\n"
            '{"exit_status":"DONE","summary":"已实现 feature X","artifacts":["file1.js"]}\n'
            "```\n"
        )
        result = call_parse_output(output)
        self.assertEqual(result["exitStatus"], "DONE")
        self.assertEqual(result["summary"], "已实现 feature X")
        self.assertEqual(result["artifacts"], ["file1.js"])

    def test_b_anti_heuristic_failed_word_with_done_json(self):
        """(b) 反启发式：自由文本含 'Failed' 但 JSON=DONE → DONE（信任 JSON 契约）。"""
        output = (
            "Looking at the previous attempt, the Failed branch was due to env.\n"
            "I fixed it.\n"
            "```json\n"
            '{"exit_status":"DONE","summary":"已修复 Failed 分支"}\n'
            "```\n"
        )
        result = call_parse_output(output)
        self.assertEqual(result["exitStatus"], "DONE")
        self.assertIn("Failed", result["output"], "原始 output 应保留")

    def test_c_no_json_block_returns_done_with_concerns(self):
        """(c) 无 JSON 块 → DONE_WITH_CONCERNS + concerns[unparseable-codex-output]。"""
        output = "I did the work but did not output JSON.\nJust plain text summary."
        result = call_parse_output(output)
        self.assertEqual(result["exitStatus"], "DONE_WITH_CONCERNS")
        self.assertIn("concerns", result)
        types = [c.get("type") for c in result["concerns"]]
        self.assertIn("unparseable-codex-output", types)

    def test_d_multiple_json_blocks_takes_last(self):
        """(d) 多个 JSON 块 → 取最后一个。"""
        output = (
            "```json\n"
            '{"exit_status":"DONE","summary":"first attempt"}\n'
            "```\n"
            "Reconsidering.\n"
            "```json\n"
            '{"exit_status":"BLOCKED","summary":"second final","p0_count":1}\n'
            "```\n"
        )
        result = call_parse_output(output)
        self.assertEqual(result["exitStatus"], "BLOCKED")
        self.assertEqual(result["summary"], "second final")
        self.assertEqual(result["p0_count"], 1)

    def test_e_bare_json_fallback(self):
        """(e) 裸 {...}（无 fenced）也能解析。"""
        output = (
            'Some context.\n'
            '{"exit_status":"DONE","summary":"bare json works","artifacts":["a"]}\n'
            "Trailing.\n"
        )
        result = call_parse_output(output)
        self.assertEqual(result["exitStatus"], "DONE")
        self.assertEqual(result["summary"], "bare json works")

    def test_f_broken_json_returns_concerns(self):
        """(f) JSON 解析失败 → DONE_WITH_CONCERNS。"""
        output = (
            "```json\n"
            "{ this is not valid json }\n"
            "```\n"
        )
        result = call_parse_output(output)
        self.assertEqual(result["exitStatus"], "DONE_WITH_CONCERNS")
        types = [c.get("type") for c in result["concerns"]]
        self.assertIn("unparseable-codex-output", types)

    def test_g_empty_output_returns_concerns(self):
        """(g) 空输出 → DONE_WITH_CONCERNS。"""
        result = call_parse_output("")
        self.assertEqual(result["exitStatus"], "DONE_WITH_CONCERNS")

    def test_h_camel_case_compatibility(self):
        """(h) 兼容 camelCase 字段（exitStatus/summary），不只是 snake_case。"""
        output = (
            "```json\n"
            '{"exitStatus":"DONE","summary":"camel case"}\n'
            "```\n"
        )
        result = call_parse_output(output)
        self.assertEqual(result["exitStatus"], "DONE")
        self.assertEqual(result["summary"], "camel case")

    def test_i_tokens_used_two_line_format(self):
        """(i) codex 输出末尾两行 'tokens used\\n9,379' → tokens_used=9379。"""
        output = (
            "```json\n"
            '{"exit_status":"DONE","summary":"ok"}\n'
            "```\n"
            "tokens used\n"
            "9,379\n"
        )
        result = call_parse_output(output)
        self.assertEqual(result["exitStatus"], "DONE")
        self.assertEqual(result["tokens_used"], 9379)

    def test_j_tokens_used_inline_format(self):
        """(j) 单行 'tokens used: 1234' → tokens_used=1234。"""
        output = (
            "```json\n"
            '{"exit_status":"DONE","summary":"ok"}\n'
            "```\n"
            "tokens used: 1234\n"
        )
        result = call_parse_output(output)
        self.assertEqual(result["tokens_used"], 1234)

    def test_k_tokens_used_no_field_when_absent(self):
        """(k) 输出不含 tokens used 行 → 结果不含 tokens_used 字段。"""
        output = (
            "```json\n"
            '{"exit_status":"DONE","summary":"ok"}\n'
            "```\n"
        )
        result = call_parse_output(output)
        self.assertNotIn("tokens_used", result)

    def test_l_tokens_used_with_large_comma_number(self):
        """(l) 大数字含千分位 '12,345,678' → 12345678。"""
        output = (
            "```json\n"
            '{"exit_status":"DONE","summary":"ok"}\n'
            "```\n"
            "tokens used\n"
            "12,345,678\n"
        )
        result = call_parse_output(output)
        self.assertEqual(result["tokens_used"], 12345678)


if __name__ == "__main__":
    unittest.main(verbosity=2)
