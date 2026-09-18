#!/usr/bin/env python3
"""regression — 多仓库回归测试工具

用法:
  regression.py run [--config PATH] [--timeout SECONDS] [--poll-interval SECONDS]

仅依赖 Python stdlib，无需外部包。
"""

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime


def load_config(path: str) -> list[dict]:
    """读取回归配置，返回仓库列表。支持简单的 YAML 子集。"""
    with open(path) as f:
        content = f.read()

    repos = []
    current = {}
    for line in content.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith('#'):
            continue
        if stripped.startswith('- name:'):
            if current.get('name') and current.get('id'):
                repos.append(current)
            current = {'name': stripped.split(':', 1)[1].strip().strip('"\'')}
        elif stripped.startswith('id:'):
            val = stripped.split(':', 1)[1].strip()
            try:
                current['id'] = int(val)
            except ValueError:
                current['id'] = val
    if current.get('name') and current.get('id'):
        repos.append(current)
    return repos


class GitlabAPI:
    """轻量 GitLab API 客户端，支持指定 project_id。"""

    def __init__(self):
        self.url = os.environ.get("CI_API_V4_URL", "https://gitlab.com/api/v4")
        self.token = os.environ.get("GITLAB_TOKEN", "")
        if not self.token:
            raise SystemExit("[regression] Error: GITLAB_TOKEN is required")

    def _request(self, method: str, project_id, path: str,
                 data: dict | None = None, timeout: int = 30):
        url = f"{self.url}/projects/{project_id}{path}"
        body = json.dumps(data).encode() if data else None
        req = urllib.request.Request(url, data=body, method=method)
        req.add_header("PRIVATE-TOKEN", self.token)
        req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read().decode()
                try:
                    return resp.status, json.loads(raw)
                except json.JSONDecodeError:
                    return resp.status, raw
        except urllib.error.HTTPError as e:
            err = e.read().decode()[:500] if e.fp else ""
            return e.code, err

    def trigger_pipeline(self, project_id, ref: str = "dev"):
        return self._request("POST", project_id, "/pipeline", {"ref": ref})

    def get_pipeline(self, project_id, pipeline_id: int):
        return self._request("GET", project_id, f"/pipelines/{pipeline_id}")


TERMINAL_STATES = {"success", "failed", "canceled"}


def cmd_run(args):
    config_path = args.config
    timeout_seconds = args.timeout
    poll_interval = args.poll_interval

    if not os.path.isfile(config_path):
        print(f"[regression] Error: Config not found: {config_path}", file=sys.stderr)
        raise SystemExit(1)

    repos = load_config(config_path)
    if not repos:
        print(f"[regression] Error: No repos configured in {config_path}", file=sys.stderr)
        raise SystemExit(1)

    gl = GitlabAPI()
    print(f"[regression] Loaded {len(repos)} repos")

    # Phase 1: Trigger all pipelines
    results = {}
    for repo in repos:
        name = repo['name']
        pid = repo['id']
        code, resp = gl.trigger_pipeline(pid)
        if 200 <= code < 300 and isinstance(resp, dict):
            pipeline_id = resp.get('id')
            web_url = resp.get('web_url', '')
            results[name] = {
                'pid': pid,
                'pipeline_id': pipeline_id,
                'web_url': web_url,
                'status': 'running',
                'started': time.time(),
            }
            print(f"[regression] Triggered {name}: #{pipeline_id} | {web_url}")
        else:
            results[name] = {
                'pid': pid,
                'status': 'trigger_failed',
                'started': time.time(),
            }
            print(f"[regression] FAILED {name}: HTTP {code}", file=sys.stderr)

    # Phase 2: Poll until done or timeout
    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        pending = [n for n, i in results.items()
                   if i['status'] not in TERMINAL_STATES and i['status'] != 'trigger_failed']
        if not pending:
            break

        for name in pending:
            info = results[name]
            _, data = gl.get_pipeline(info['pid'], info['pipeline_id'])
            if isinstance(data, dict):
                status = data.get('status', 'unknown')
                if status in TERMINAL_STATES:
                    info['status'] = status
                    elapsed = int(time.time() - info['started'])
                    print(f"[regression] {name}: {status} ({elapsed}s)")

        time.sleep(poll_interval)

    # Mark timeouts
    for info in results.values():
        if info['status'] not in TERMINAL_STATES and info['status'] != 'trigger_failed':
            info['status'] = 'timeout'

    # Phase 3: Report
    now = datetime.now().strftime('%Y-%m-%d')
    passed = sum(1 for i in results.values() if i['status'] == 'success')
    failed = len(results) - passed

    lines = [
        f"\n# 回归报告 {now}\n",
        "| 仓库 | 状态 | 耗时 |",
        "|------|------|------|",
    ]
    for name, info in results.items():
        icon = "✅" if info['status'] == 'success' else "❌"
        elapsed = ""
        if info['status'] == 'timeout':
            elapsed = f"{timeout_seconds}s+"
        elif 'started' in info:
            elapsed = f"{int(time.time() - info['started'])}s"
        lines.append(f"| {name} | {icon} {info['status']} | {elapsed} |")
    lines.append(f"\n汇总: ✅ {passed} / ❌ {failed}")

    print('\n'.join(lines))


def main():
    parser = argparse.ArgumentParser(description="regression — 多仓库回归测试")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("run", help="触发回归并等待结果")
    p.add_argument("--config", default=".claude/config/regression.yaml")
    p.add_argument("--timeout", type=int, default=600, help="超时秒数 (默认 600)")
    p.add_argument("--poll-interval", type=int, default=30, help="轮询间隔秒数 (默认 30)")

    args = parser.parse_args()
    if args.command == "run":
        cmd_run(args)


if __name__ == "__main__":
    main()
