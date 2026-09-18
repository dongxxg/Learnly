#!/usr/bin/env python3
"""
Tests for CodexBackend._parseJsonlOutput JSONL 事件流解析（Phase 3a / tasks 7.5-7.7）

覆盖场景：
  (a) 标准 JSONL：turn.completed.usage + 多 agent_message + reasoning → 正确提取 tokens_used + 拼接 text
  (b) JSONL 含 error 事件（rate_limit）→ BLOCKED + concerns 含 rate_limit
  (c) JSONL 无 turn.completed（极端情况）→ 回退 plain text 解析

JSONL 事件契约（codex exec --json）：
  {"type":"session.started",...}
  {"type":"item.completed","item":{"type":"agent_message","text":"..."}}
  {"type":"item.completed","item":{"type":"reasoning","text":"..."}}
  {"type":"item.completed","item":{"type":"error","message":"..."}}
  {"type":"turn.completed","usage":{"input_tokens":N,"cached_input_tokens":N,"output_tokens":N,"reasoning_output_tokens":N}}

测试通过 subprocess 调 node，因为 codex-backend.js 是 ESM 模块。
"""

import json
import os
import subprocess
import unittest

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, "..", "..", "..", ".."))
CODEX_BACKEND = os.path.join(PROJECT_ROOT, ".claude", "backends", "codex-backend.js")


def call_parse_jsonl_output(jsonl_text, role="developer"):
    """调 CodexBackend._parseJsonlOutput 通过 node 子进程，返回解析后的 dict。"""
    js = """
import { pathToFileURL } from 'node:url';
const mod = await import(pathToFileURL(process.env.MODULE_PATH).href);
const backend = new mod.CodexBackend();
const out = backend._parseJsonlOutput(process.env.JSONL_INPUT, process.env.ROLE || 'developer');
process.stdout.write(JSON.stringify(out));
"""
    env = os.environ.copy()
    env["MODULE_PATH"] = CODEX_BACKEND
    env["JSONL_INPUT"] = jsonl_text
    env["ROLE"] = role
    result = subprocess.run(
        ["node", "--input-type=module", "-e", js],
        capture_output=True, text=True, env=env, cwd=PROJECT_ROOT,
    )
    if result.returncode != 0:
        raise AssertionError(
            f"node subprocess failed (rc={result.returncode}):\n"
            f"stderr: {result.stderr}\nstdout: {result.stdout}"
        )
    return json.loads(result.stdout)


def call_parse_output_with_jsonl(jsonl_text):
    """通过 _parseOutput 入口验证 JSONL→plain text fallback 切换。"""
    js = """
import { pathToFileURL } from 'node:url';
const mod = await import(pathToFileURL(process.env.MODULE_PATH).href);
const backend = new mod.CodexBackend();
const out = backend._parseOutput(process.env.JSONL_INPUT, 'developer');
process.stdout.write(JSON.stringify(out));
"""
    env = os.environ.copy()
    env["MODULE_PATH"] = CODEX_BACKEND
    env["JSONL_INPUT"] = jsonl_text
    result = subprocess.run(
        ["node", "--input-type=module", "-e", js],
        capture_output=True, text=True, env=env, cwd=PROJECT_ROOT,
    )
    if result.returncode != 0:
        raise AssertionError(
            f"node subprocess failed (rc={result.returncode}):\n"
            f"stderr: {result.stderr}\nstdout: {result.stdout}"
        )
    return json.loads(result.stdout)


class TestCodexJsonlParsing(unittest.TestCase):
    """CodexBackend._parseJsonlOutput JSONL 解析契约（Phase 3a / tasks 3.2-3.5）"""

    def setUp(self):
        if not os.path.exists(CODEX_BACKEND):
            self.skipTest(f"codex-backend.js not found at {CODEX_BACKEND}")

    def test_a_standard_jsonl_extracts_tokens_and_text(self):
        """(a) 标准 JSONL：含 turn.completed.usage + 多 agent_message → 正确提取 tokens_used + 拼接 text + 提取 JSON 尾块。"""
        jsonl = "\n".join([
            '{"type":"session.started","session_id":"abc"}',
            '{"type":"item.completed","item":{"type":"agent_message","text":"I will implement feature X."}}',
            '{"type":"item.completed","item":{"type":"reasoning","text":"thinking..."}}',
            '{"type":"item.completed","item":{"type":"agent_message","text":"Done.\\n```json\\n{\\"exit_status\\":\\"DONE\\",\\"summary\\":\\"ok\\",\\"artifacts\\":[\\"a.js\\"]}\\n```"}}',
            '{"type":"turn.completed","usage":{"input_tokens":9365,"cached_input_tokens":4480,"output_tokens":11,"reasoning_output_tokens":9}}',
        ])
        result = call_parse_jsonl_output(jsonl, "developer")
        # tokens_used = input + output = 9365 + 11 = 9376
        self.assertEqual(result["tokens_used"], 9376)
        # usage 子字段记录（cached / reasoning）
        self.assertEqual(result["usage"]["cached_input_tokens"], 4480)
        self.assertEqual(result["usage"]["reasoning_output_tokens"], 9)
        # 拼接 agent_message text（按出现顺序）
        self.assertIn("I will implement feature X.", result["reconstructed_text"])
        self.assertIn("Done.", result["reconstructed_text"])
        # C002 修复：_parseJsonlOutput 不再提取 parsed_json（职责分离给 _parseOutput）
        self.assertNotIn("parsed_json", result)
        # sub-agent JSON 提取由 _parseOutput 通过 _extractLastJsonBlock(reconstructed_text) 负责
        # （由 test_codex_parse_output_json.py / test_dispatch_codex_backend_flow.sh 覆盖）
        # 找到 turn.completed 事件
        self.assertTrue(result["has_turn_completed"])

    def test_b_jsonl_with_rate_limit_error_event(self):
        """(b) JSONL 含 item.completed.type=error (rate_limit) → exitStatus=BLOCKED + concerns 含 rate_limit。"""
        jsonl = "\n".join([
            '{"type":"session.started"}',
            '{"type":"item.completed","item":{"type":"agent_message","text":"starting..."}}',
            '{"type":"item.completed","item":{"type":"error","message":"RateLimitError: too many requests"}}',
            '{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":5}}',
        ])
        result = call_parse_jsonl_output(jsonl, "developer")
        self.assertEqual(result["exitStatus"], "BLOCKED")
        self.assertIsNotNone(result.get("error"))
        self.assertIn("rate_limit", json.dumps(result.get("concerns", [])))

    def test_c_jsonl_no_turn_completed_falls_back(self):
        """(c) JSONL 无 turn.completed（极端情况）→ _parseJsonlOutput 返回 null/fallback 信号，_parseOutput 回退 plain text。"""
        jsonl = "\n".join([
            '{"type":"session.started"}',
            '{"type":"item.completed","item":{"type":"agent_message","text":"partial output, no turn completed"}}',
            # 没有 turn.completed
        ])
        result = call_parse_jsonl_output(jsonl, "developer")
        # _parseJsonlOutput 应该报告 has_turn_completed=false（让 _parseOutput 走 fallback）
        self.assertFalse(result.get("has_turn_completed", False))

    def test_d_parse_output_uses_jsonl_path_when_turn_completed_present(self):
        """(d) _parseOutput 优先用 JSONL 路径，提取 sub-agent JSON + tokens_used."""
        jsonl = "\n".join([
            '{"type":"item.completed","item":{"type":"agent_message","text":"```json\\n{\\"exit_status\\":\\"DONE\\",\\"summary\\":\\"ok\\"}\\n```"}}',
            '{"type":"turn.completed","usage":{"input_tokens":500,"output_tokens":20}}',
        ])
        result = call_parse_output_with_jsonl(jsonl)
        self.assertEqual(result["exitStatus"], "DONE")
        self.assertEqual(result["summary"], "ok")
        self.assertEqual(result["tokens_used"], 520)  # 500 + 20

    def test_e_parse_output_falls_back_to_plain_text_when_no_turn_completed(self):
        """(e) _parseOutput 在无 turn.completed 时回退到 plain text 解析（旧路径）。"""
        # 不含任何 JSONL 行，纯 plain text
        plain = (
            "I did the work.\n"
            "```json\n"
            '{"exit_status":"DONE","summary":"plain text fallback works"}\n'
            "```\n"
            "tokens used\n"
            "1,234\n"
        )
        result = call_parse_output_with_jsonl(plain)
        self.assertEqual(result["exitStatus"], "DONE")
        self.assertEqual(result["summary"], "plain text fallback works")
        self.assertEqual(result["tokens_used"], 1234)

    def test_f_multiple_agent_messages_concatenated_in_order(self):
        """(f) 多个 agent_message 事件按出现顺序拼接，_extractLastJsonBlock 取最后一个 JSON 块。"""
        jsonl = "\n".join([
            '{"type":"item.completed","item":{"type":"agent_message","text":"first message"}}',
            '{"type":"item.completed","item":{"type":"agent_message","text":"```json\\n{\\"exit_status\\":\\"DONE_WITH_CONCERNS\\",\\"summary\\":\\"first\\"}\\n```"}}',
            '{"type":"item.completed","item":{"type":"agent_message","text":"middle"}}',
            '{"type":"item.completed","item":{"type":"agent_message","text":"```json\\n{\\"exit_status\\":\\"DONE\\",\\"summary\\":\\"final\\"}\\n```"}}',
            '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":5}}',
        ])
        result = call_parse_output_with_jsonl(jsonl)
        self.assertEqual(result["exitStatus"], "DONE")
        self.assertEqual(result["summary"], "final")

    def test_g_anti_heuristic_failed_word_with_done_json(self):
        """(g) 反启发式：JSONL agent_message text 含 'Failed' 但 JSON=DONE → DONE。"""
        jsonl = "\n".join([
            '{"type":"item.completed","item":{"type":"agent_message","text":"the previous attempt Failed, but I fixed it."}}',
            '{"type":"item.completed","item":{"type":"agent_message","text":"```json\\n{\\"exit_status\\":\\"DONE\\",\\"summary\\":\\"fixed Failed branch\\"}\\n```"}}',
            '{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":10}}',
        ])
        result = call_parse_output_with_jsonl(jsonl)
        self.assertEqual(result["exitStatus"], "DONE")


if __name__ == "__main__":
    unittest.main(verbosity=2)
