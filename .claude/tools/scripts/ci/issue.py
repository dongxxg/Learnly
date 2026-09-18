#!/usr/bin/env python3
"""ci-issue — 通过 GitLab API 管理与 AI 评审相关的 Issue

用法:
  ci-issue.py create --severity P0|P1|P2 --dimension architecture|code|test|security|docs [--mr MR_IID] [--title TITLE] [--desc DESC]
  ci-issue.py close --iid ISSUE_IID [--mr MR_IID]
  ci-issue.py list [--severity P0] [--dimension security]

描述可从 stdin 读取。仅依赖 Python stdlib，无需外部包。
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import typing
import urllib.error
import urllib.request
from datetime import datetime

GITLAB_URL = os.environ.get("CI_API_V4_URL", "https://gitlab.com/api/v4")
PROJECT_ID = os.environ.get("CI_PROJECT_ID", "")
TOKEN = os.environ.get("GITLAB_TOKEN", "")

DIM_LABELS = {
    "architecture": "ai-dimension:architecture",
    "code": "ai-dimension:code",
    "test": "ai-dimension:test",
    "security": "ai-dimension:security",
    "docs": "ai-dimension:docs",
}


def _request(method: str, path: str, data: dict | None = None,
             timeout: int = 30, retries: int = 3) -> tuple[int, typing.Any]:
    url = f"{GITLAB_URL}/projects/{PROJECT_ID}{path}"
    body = json.dumps(data).encode() if data else None
    for attempt in range(1, retries + 1):
        try:
            req = urllib.request.Request(url, data=body, method=method)
            req.add_header("PRIVATE-TOKEN", TOKEN)
            req.add_header("Content-Type", "application/json")
            req.add_header("User-Agent", "ci-issue/1.0")
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read().decode()
                try:
                    return resp.status, json.loads(raw)
                except json.JSONDecodeError:
                    return resp.status, raw
        except (urllib.error.HTTPError, OSError):
            if attempt < retries:
                time.sleep(min(5 * attempt, 15))
            if attempt >= retries:
                raise
    raise SystemExit(f"[ci-issue] Error: API request failed after {retries} retries")


def _find_existing_issue(title: str, extra_labels: list[str] | None = None) -> int | None:
    """搜索已存在的同标题 open Issue，返回 IID 或 None。"""
    labels = ["ai-detected"]
    if extra_labels:
        labels.extend(extra_labels)
    params = [f"labels[]={l}" for l in labels]
    params.append("state=opened")
    params.append("per_page=20")
    qs = "&".join(params)
    try:
        _, issues = _request("GET", f"/issues?{qs}")
    except Exception:
        return None
    if not isinstance(issues, list):
        return None
    for i in issues:
        if i.get("title") == title:
            return i["iid"]
    return None


def cmd_create(args: argparse.Namespace):
    severity = args.severity
    if severity not in ("P0", "P1", "P2"):
        print(f"[ci-issue] Error: --severity must be P0, P1, or P2 (got: {severity})", file=sys.stderr)
        raise SystemExit(1)

    dimension = args.dimension or "code"
    title = args.title or f"[CI-AI] {severity}: AI review finding ({dimension})"
    desc = args.desc or ""

    # Read from stdin if piped
    if not desc and not sys.stdin.isatty():
        desc = sys.stdin.read()

    labels = ["ai-detected", severity]
    dim_label = DIM_LABELS.get(dimension)
    if dim_label:
        labels.append(dim_label)
    labels_csv = ",".join(labels)

    full_desc = f"""## AI 评审发现

| 属性 | 值 |
|------|-----|
| 严重级别 | **{severity}** |
| 问题维度 | {dimension} |
| 发现方式 | CI AI Reviewer 自动检测 |
"""
    if args.mr:
        full_desc += f"| 来源 MR | !{args.mr} |\n"

    if desc:
        full_desc += f"\n## 问题描述\n\n{desc}"

    # 去重：检查是否已存在同标题 open Issue
    existing = _find_existing_issue(title, extra_labels=[severity])
    if existing is not None:
        print(existing)
        print(f"[ci-issue] Issue !{existing} already exists (same title), skipping", file=sys.stderr)
        return

    full_desc += f"\n\n---\n*由 CI AI 自动创建 · {datetime.now():%Y-%m-%d %H:%M}*"

    code, resp = _request("POST", "/issues", {
        "title": title,
        "description": full_desc,
        "labels": labels_csv,
        "confidential": args.confidential,
    })

    if 200 <= code < 300:
        iid = resp.get("iid")
        web_url = resp.get("web_url", "")
        print(iid)
        print(f"[ci-issue] Created Issue !{iid}: {web_url}", file=sys.stderr)
    else:
        print(f"[ci-issue] Error creating issue: HTTP {code} — {resp}", file=sys.stderr)
        raise SystemExit(1)


def cmd_close(args: argparse.Namespace):
    iid = args.iid
    if not iid:
        print("[ci-issue] Error: --iid is required for close", file=sys.stderr)
        raise SystemExit(1)

    try:
        state = _request("GET", f"/issues/{iid}")[1].get("state", "unknown")
    except Exception:
        state = "unknown"

    if state == "closed":
        print(f"[ci-issue] Issue !{iid} already closed, skipping", file=sys.stderr)
        return

    code, _ = _request("PUT", f"/issues/{iid}", {"state_event": "close"})
    if 200 <= code < 300:
        print(f"[ci-issue] Closed Issue !{iid}", file=sys.stderr)
        if args.mr:
            _request("POST", f"/issues/{iid}/notes",
                     {"body": f"Closed by CI AI pipeline · Fix MR: !{args.mr}"})
    else:
        print(f"[ci-issue] Error closing issue: HTTP {code}", file=sys.stderr)
        raise SystemExit(1)


def cmd_list(args: argparse.Namespace):
    params = []
    if args.severity:
        params.append(f"labels[]={args.severity}")
    if args.dimension:
        dim_label = DIM_LABELS.get(args.dimension, "")
        if dim_label:
            params.append(f"labels[]={dim_label}")
    params.append("labels[]=ai-detected")
    params.append("state=opened")
    params.append("per_page=20")

    qs = "&".join(params)
    try:
        _, issues = _request("GET", f"/issues?{qs}")
    except Exception:
        print("[ci-issue] No open AI-detected issues")
        return

    if not isinstance(issues, list) or len(issues) == 0:
        print("[ci-issue] No open AI-detected issues")
        return

    print(f"[ci-issue] {len(issues)} open AI-detected issue(s):")
    for i in issues:
        labels = ", ".join(i.get("labels", []))
        print(f"  !{i['iid']} [{labels}] {i.get('title','')}")


def main():
    parser = argparse.ArgumentParser(
        description="ci-issue — GitLab Issue 管理",
        prog="ci-issue.py",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("create", help="创建 Issue")
    p.add_argument("--severity", required=True)
    p.add_argument("--dimension", default="code")
    p.add_argument("--mr", default=None)
    p.add_argument("--title", default=None)
    p.add_argument("--desc", default=None)
    p.add_argument("--confidential", action="store_true", default=False)

    p = sub.add_parser("close", help="关闭 Issue")
    p.add_argument("--iid", type=int, required=True)
    p.add_argument("--mr", default=None)

    p = sub.add_parser("list", help="列出 Issue")
    p.add_argument("--severity", default=None)
    p.add_argument("--dimension", default=None)

    args = parser.parse_args()

    if not TOKEN:
        print("[ci-issue] Error: GITLAB_TOKEN is required", file=sys.stderr)
        raise SystemExit(1)

    match args.command:
        case "create":
            cmd_create(args)
        case "close":
            cmd_close(args)
        case "list":
            cmd_list(args)


if __name__ == "__main__":
    main()
