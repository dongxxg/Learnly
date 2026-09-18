#!/usr/bin/env python3
"""ci-archiver — rd archive 归档 + 关闭 Issue

用法:
  ci-archiver.py run --issue-iid=<iid> [--change=<name>]

仅依赖 Python stdlib + rd CLI + git，无需外部包。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
BRIDGE = os.path.join(SCRIPT_DIR, "..", "ci-bridge.sh")
GITLAB_URL = os.environ.get("CI_API_V4_URL", "https://gitlab.com/api/v4")
PROJECT_ID = os.environ.get("CI_PROJECT_ID", "")
TOKEN = os.environ.get("GITLAB_TOKEN", "")
DEFAULT_BRANCH = os.environ.get("CI_DEFAULT_BRANCH", "dev")


def run_bridge(*args: str) -> None:
    subprocess.run(["bash", BRIDGE, *args], capture_output=True, check=False)


def run_git(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["git", *args], capture_output=True, text=True)


def cmd_run(issue_iid: str, change_name: str):
    if not change_name and issue_iid:
        change_name = f"issue-{issue_iid}"

    if not change_name:
        try:
            result = subprocess.run(["rd", "list", "--json"],
                                    capture_output=True, text=True)
            data = json.loads(result.stdout)
            complete = [c["name"] for c in data.get("changes", [])
                        if c.get("status") == "complete"]
            change_name = complete[0] if complete else ""
        except Exception:
            pass

    if not change_name:
        print("[ci-archiver] No changes to archive, skipping")
        return

    if not issue_iid:
        m = re.search(r'issue-(\d+)', change_name)
        if m:
            issue_iid = m.group(1)

    print(f"[ci-archiver] Archiving change: {change_name} for Issue !{issue_iid}")

    spec_branch = f"ci/ai-spec-{issue_iid}"
    spec_dir = f".harness/spec/changes/{change_name}"

    print(f"[ci-archiver] Fetching SPEC from {spec_branch}...")
    p = run_git("fetch", "origin", spec_branch)
    if p.returncode == 0:
        run_git("checkout", f"origin/{spec_branch}", "--", f"{spec_dir}/")

    if not os.path.isdir(spec_dir):
        print(f"[ci-archiver] SPEC directory {spec_dir} not found, skipping archive")
        return

    subprocess.run(["rd", "archive", change_name, "-y"], check=False)

    run_git("add", ".harness/spec/")
    p = run_git("diff", "--cached", "--quiet")
    if p.returncode == 0:
        print("[ci-archiver] No archive changes to commit")
    else:
        run_git("commit", "-m",
                f"ci-archiver: Archive {change_name} for Issue #{issue_iid}")

        print(f"[ci-archiver] Pushing to SPEC branch: {spec_branch}")
        run_git("push", "origin", f"HEAD:{spec_branch}")

        if TOKEN and issue_iid:
            mr_title = f"ci-archiver: Archive {change_name} (Issue #{issue_iid})"
            print(f"[ci-archiver] Creating MR: {spec_branch} -> {DEFAULT_BRANCH}")
            run_bridge("create-mr",
                       f"--source={spec_branch}",
                       f"--target={DEFAULT_BRANCH}",
                       f"--title={mr_title}",
                       "--labels=ci-ai,archive-review",
                       f"--issue-iid={issue_iid}")
        else:
            print("[ci-archiver] WARNING: No GITLAB_TOKEN or issue_iid, "
                  "falling back to direct push")
            run_git("push", "origin", f"HEAD:{DEFAULT_BRANCH}")

    if issue_iid and TOKEN:
        run_bridge("update-issue-label", issue_iid,
                   "--add=ai-done",
                   "--remove=ai-testing,ai-archiving,ai-review,ai-in-progress")
        run_bridge("close-issue", issue_iid,
                   "--comment=SPEC 已归档完成，MR 已创建等待自动合并。")

    print(f"[ci-archiver] Complete: {change_name} archived, Issue !{issue_iid} closed")


def main():
    parser = argparse.ArgumentParser(
        description="ci-archiver — 归档 SPEC 并关闭 Issue",
        prog="ci-archiver.py",
    )
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("run", help="执行归档")
    p.add_argument("--issue-iid", default="")
    p.add_argument("--change", default="")
    args = parser.parse_args()

    if args.command == "run":
        cmd_run(args.issue_iid, getattr(args, 'change', ''))


if __name__ == "__main__":
    main()
