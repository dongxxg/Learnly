#!/usr/bin/env python3
"""ci-scheduler — 定时扫描 Issue Backlog + 僵尸检测

用法:
  ci-scheduler.py scan --label=<label> --limit=<n>
  ci-scheduler.py detect-zombies

仅依赖 Python stdlib + git，无需外部包。
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
import typing
import urllib.error
import urllib.request
from datetime import datetime, timezone

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
BRIDGE = os.path.join(SCRIPT_DIR, "..", "ci-bridge.sh")
GITLAB_URL = os.environ.get("CI_API_V4_URL", "https://gitlab.com/api/v4")
PROJECT_ID = os.environ.get("CI_PROJECT_ID", "")
TOKEN = os.environ.get("GITLAB_TOKEN", "")
CURL_OPTS = "--max-time 30 --retry 3 --retry-delay 5"

DEBOUNCE_MINUTES = 10
ZOMBIE_THRESHOLD_MINUTES = 60


def _request(method: str, path: str, data: dict | None = None,
             timeout: int = 30, retries: int = 3) -> tuple[int, typing.Any]:
    url = f"{GITLAB_URL}/projects/{PROJECT_ID}{path}"
    body = json.dumps(data).encode() if data else None
    for attempt in range(1, retries + 1):
        try:
            req = urllib.request.Request(url, data=body, method=method)
            req.add_header("PRIVATE-TOKEN", TOKEN)
            req.add_header("Content-Type", "application/json")
            req.add_header("User-Agent", "ci-scheduler/1.0")
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
    raise SystemExit(f"[ci-scheduler] Error: API request failed after {retries} retries")


def run_bridge(*args: str) -> None:
    subprocess.run(["bash", BRIDGE, *args], capture_output=True, check=False)


def add_note(iid: int, msg: str):
    try:
        _request("POST", f"/issues/{iid}/notes", {"body": msg})
    except Exception:
        pass


BRIDGE_PY = os.path.join(SCRIPT_DIR, "ci", "bridge.py")


def add_structured_note(iid: int, msg: str, event: str, stage: str = "scheduler",
                        metadata: dict | None = None):
    """写入结构化 Note（含 rd_harness:metadata HTML 注释）。"""
    import importlib.util
    spec = importlib.util.spec_from_file_location("bridge", BRIDGE_PY)
    if spec is None or spec.loader is None:
        add_note(iid, msg)
        return
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    rd_meta = mod.build_metadata(event, stage, metadata)
    try:
        _request("POST", f"/issues/{iid}/notes",
                 {"body": f"{msg}\n\n<!-- rd_harness:metadata\n{json.dumps(rd_meta, ensure_ascii=False, indent=2)}\n-->"})
    except Exception:
        pass


def check_debounce(iid: int) -> bool:
    """Return True if enough time has passed since last update."""
    try:
        _, issue = _request("GET", f"/issues/{iid}")
        updated_at = issue.get("updated_at", "1970-01-01T00:00:00Z")
        updated_epoch = datetime.fromisoformat(
            updated_at.replace("Z", "+00:00")).timestamp()
        now_epoch = datetime.now(timezone.utc).timestamp()
        diff_min = (now_epoch - updated_epoch) / 60
        if diff_min < DEBOUNCE_MINUTES:
            print(f"[ci-scheduler] Issue !{iid} updated {diff_min:.0f} min ago "
                  f"(< {DEBOUNCE_MINUTES} min debounce), skipping")
            return False
    except Exception:
        pass
    return True


def check_failure_circuit(iid: int) -> bool:
    """Return False if circuit breaker triggered."""
    try:
        _, notes = _request("GET", f"/issues/{iid}/notes?sort=desc&per_page=50")
        if not isinstance(notes, list):
            return True
        consecutive_fails = 0
        for n in notes:
            if "⚠️ CI-AI-FAIL" in n.get("body", ""):
                consecutive_fails += 1
            else:
                break
        if consecutive_fails >= 3:
            print(f"[ci-scheduler] Issue !{iid} has {consecutive_fails} consecutive failures, "
                  "circuit breaker triggered")
            run_bridge("update-issue-label", str(iid),
                       "--add=ai-blocked", "--remove=ai-in-progress,ai-review,ai-testing")
            add_note(iid, "⚠️ 自动流程连续失败 3 次，已暂停。请 PM 手动检查。")
            add_structured_note(iid, "🔥 熔断触发",
                               event="circuit_breaker",
                               metadata={"consecutive_failures": consecutive_fails})
            return False
    except Exception:
        pass
    return True


def cmd_scan(label: str, limit: int):
    import urllib.parse
    encoded = urllib.parse.quote(label, safe="")
    params = (f"state=opened&labels={encoded}&per_page={limit}"
              "&order_by=updated_at&sort=asc")
    _, issues = _request("GET", f"/issues?{params}")

    if not isinstance(issues, list) or len(issues) == 0:
        print(f"[ci-scheduler] No Issues with label '{label}', exiting")
        return

    print(f"[ci-scheduler] Found {len(issues)} Issue(s) with label '{label}'")

    first = issues[0]
    iid = first["iid"]
    title = first.get("title", "")
    print(f"[ci-scheduler] Picking Issue !{iid}: {title}")

    if not check_debounce(iid):
        return
    if not check_failure_circuit(iid):
        return

    run_bridge("update-issue-label", str(iid),
               "--add=ai-in-progress", "--remove=ai-todo")

    env_file = os.environ.get("CI_PROJECT_DIR", ".") + "/detect-env.txt"
    with open(env_file, "w") as f:
        f.write(f"ISSUE_IID={iid}\nISSUE_TITLE={title}\n")

    print(f"[ci-scheduler] Issue !{iid} assigned to Architect")


def cmd_detect_zombies():
    zombie_labels = ["ai-in-progress", "ai-review", "ai-testing"]
    found = 0

    for label in zombie_labels:
        import urllib.parse
        encoded = urllib.parse.quote(label, safe="")
        _, issues = _request("GET",
                             f"/issues?state=opened&labels={encoded}&per_page=20")
        if not isinstance(issues, list):
            continue

        now_epoch = datetime.now(timezone.utc).timestamp()
        for issue in issues:
            updated_at = issue.get("updated_at", "1970-01-01T00:00:00Z")
            try:
                updated_epoch = datetime.fromisoformat(
                    updated_at.replace("Z", "+00:00")).timestamp()
            except (ValueError, OSError):
                updated_epoch = 0
            diff_min = (now_epoch - updated_epoch) / 60

            if diff_min > ZOMBIE_THRESHOLD_MINUTES:
                iid = issue["iid"]
                print(f"[ci-scheduler] Zombie detected: Issue !{iid} "
                      f"({label}, {diff_min:.0f} min stale)")
                run_bridge("update-issue-label", str(iid),
                           "--add=ai-blocked", "--remove=" + label)
                add_note(iid, f"⚠️ 流程意外中断（{label} 超过 "
                         f"{ZOMBIE_THRESHOLD_MINUTES} 分钟无进展），"
                         "请 PM 检查后将 label 改回 ai-todo 重试，或关闭 Issue")
                add_structured_note(iid, f"🧟 僵尸检测: {label} 静止 {diff_min:.0f} 分钟",
                                   event="zombie_detected",
                                   metadata={"stale_minutes": int(diff_min),
                                             "last_label": label})
                found += 1

    if found == 0:
        print("[ci-scheduler] No zombie Issues detected")
    else:
        print(f"[ci-scheduler] Marked {found} zombie Issue(s) as ai-blocked")


def main():
    parser = argparse.ArgumentParser(
        description="ci-scheduler — Issue 扫描与僵尸检测",
        prog="ci-scheduler.py",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("scan", help="扫描 backlog")
    p.add_argument("--label", default="ai-todo")
    p.add_argument("--limit", type=int, default=1)

    sub.add_parser("detect-zombies", help="检测僵尸 Issue")

    args = parser.parse_args()

    if not TOKEN:
        print("[ci-scheduler] Error: GITLAB_TOKEN is required", file=sys.stderr)
        raise SystemExit(1)

    match args.command:
        case "scan":
            cmd_scan(args.label, args.limit)
        case "detect-zombies":
            cmd_detect_zombies()


if __name__ == "__main__":
    main()
