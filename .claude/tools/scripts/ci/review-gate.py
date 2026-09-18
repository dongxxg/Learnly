#!/usr/bin/env python3
"""ci-review-gate — 解析 review-result.json，按评分阈值路由

用法: ci-review-gate.py <review-file> <output-file>
"""

import json
import os
import re
import subprocess
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
CI_ISSUE = os.path.join(SCRIPT_DIR, "..", "ci-issue.sh")
TOKEN = os.environ.get("GITLAB_TOKEN", "")


DIM_TO_TARGET = {
    "architecture": "architect",
    "code": "developer",
    "test": "tester",
    "security": "architect+developer",
    "docs": "reviewer",
}


def create_issue(severity: str, dimension: str, mr_iid: str, desc: str) -> str:
    """Create a GitLab issue via ci-issue.sh, return IID or empty string.

    Auto-issue creation is OFF by default since v1.23.0 — review findings still
    reported in pipeline output and routed (block/rework), just no GitLab issue
    is auto-created (P0 no longer auto-appears in the Issue list).
    Opt back in with CI_ENABLE_ISSUE_CREATE=1; legacy CI_DISABLE_ISSUE_CREATE=1
    still forces it off and takes precedence over CI_ENABLE_ISSUE_CREATE.
    """
    if os.environ.get("CI_DISABLE_ISSUE_CREATE") == "1":
        print(f"[ci-gate] CI_DISABLE_ISSUE_CREATE=1, skip creating {severity} issue")
        return ""
    if os.environ.get("CI_ENABLE_ISSUE_CREATE") != "1":
        print(f"[ci-gate] CI_ENABLE_ISSUE_CREATE unset (default OFF), skip creating {severity} issue")
        return ""
    if not TOKEN or not mr_iid:
        return ""
    result = subprocess.run(
        ["bash", CI_ISSUE, "create",
         "--severity", severity,
         "--dimension", dimension,
         "--mr", mr_iid,
         "--desc", desc],
        capture_output=True, text=True,
    )
    if result.returncode == 0:
        iid = result.stdout.strip()
        m = re.search(r'(\d+)', iid)
        if m:
            return m.group(1)
    return ""


def main():
    # Parse --hotfix flag (can appear anywhere in args)
    hotfix = False
    args = [a for a in sys.argv[1:] if not a.startswith("--hotfix") or (hotfix := True)]
    # Re-check: filter out --hotfix properly
    hotfix = "--hotfix" in sys.argv
    args = [a for a in sys.argv[1:] if a != "--hotfix"]

    review_file = args[0] if len(args) > 0 else "review-result.json"
    output_file = args[1] if len(args) > 1 else "review-gate-result.txt"
    mr_iid = os.environ.get("CI_MERGE_REQUEST_IID", "")

    if hotfix:
        print("[ci-gate] Hotfix mode: lowered threshold to 70, debate bypassed")

    if not os.path.isfile(review_file):
        with open(output_file, "w") as f:
            f.write("ROUTE=error\nTARGET_ROLE=none\nISSUE_IID=\n")
        print(f"[ci-gate] Error: {review_file} not found")
        raise SystemExit(1)

    with open(review_file) as f:
        review = json.load(f)

    score = review.get("score", 0)
    p0_count = review.get("p0_count", 0)
    dimension = review.get("problem_dimension", "code")
    details = review.get("details", "No details")

    route = "pass"
    target_role = "none"
    issue_iid = ""

    # P0 一票否决
    if p0_count > 0:
        score = 0
        route = "block"
        target_role = "all"
        print(f"[ci-gate] BLOCKED: {p0_count} P0 issue(s) found (score forced to 0)")
        issue_iid = create_issue("P0", dimension, mr_iid, details)
        if issue_iid:
            print(f"[ci-gate] Created Issue !{issue_iid} for P0 findings")
    elif hotfix:
        # Hotfix 模式：阈值 70，70+ 直接 pass，<70 rework
        if score < 70:
            route = "rework"
            target_role = "developer"
            print(f"[ci-gate] REWORK (hotfix): score={score} < 70, route to developer")
        else:
            route = "pass"
            target_role = "none"
            print(f"[ci-gate] PASS (hotfix): score={score} >= 70, direct pass")
    # < 75 返工
    elif score < 75:
        route = "rework"
        target_role = DIM_TO_TARGET.get(dimension, "developer")
        print(f"[ci-gate] REWORK: score={score} < 75, route to {target_role} ({dimension})")
        issue_iid = create_issue("P1", dimension, mr_iid,
                                 f"评分 {score} < 75，需要 {target_role} 返工修复。\n\n{details}")
        if issue_iid:
            print(f"[ci-gate] Created Issue !{issue_iid} for rework findings")
    # 75-79 Debate
    elif score < 80:
        route = "debate"
        target_role = "debate"
        print(f"[ci-gate] DEBATE: score={score} in [75,80), triggering adversarial audit")
    # 80-89 通过
    elif score < 90:
        route = "pass"
        target_role = "reviewer"
        print(f"[ci-gate] PASS: score={score} in [80,90), reviewer may fix minor issues")
    # >= 90 直接通过
    else:
        route = "pass"
        target_role = "none"
        print(f"[ci-gate] PASS: score={score} >= 90, direct pass")

    with open(output_file, "w") as f:
        f.write(f"ROUTE={route}\n")
        f.write(f"TARGET_ROLE={target_role}\n")
        f.write(f"SCORE={score}\n")
        f.write(f"P0_COUNT={p0_count}\n")
        f.write(f"PROBLEM_DIMENSION={dimension}\n")
        f.write(f"ISSUE_IID={issue_iid}\n")


if __name__ == "__main__":
    main()
