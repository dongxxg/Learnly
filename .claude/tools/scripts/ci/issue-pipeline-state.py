#!/usr/bin/env python3
"""issue-pipeline-state — Issue 工作项流水线状态管理

用法:
  issue-pipeline-state.py init <issue_iid> <title> [--criteria=<...>]
  issue-pipeline-state.py update-stage <issue_iid> <stage> <status> [--score=<n>] [--details=<...>]
  issue-pipeline-state.py show <issue_iid> [--format=json|table]
  issue-pipeline-state.py list [--status=<status>]

管理 .harness/tasks/issue-{IID}/pipeline-state.json 的创建、更新和查询。
仅依赖 Python stdlib，无需外部包。
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone


SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
TASKS_DIR = os.environ.get(
    "CI_PROJECT_DIR",
    os.path.join(SCRIPT_DIR, "..", "..", "..", "..", "..")
)
TASKS_DIR = os.path.join(TASKS_DIR, ".harness", "tasks")

ISSUE_PIPELINE_STAGES = [
    "architect",
    "spec-review",
    "developer",
    "code-review",
    "gate",
    "debate",
    "test",
    "notify",
    "archive",
    "merge",
]

STAGE_TRANSITIONS = {
    "architect":    ["spec-review"],
    "spec-review":  ["developer", "architect"],
    "developer":    ["code-review", "architect"],
    "code-review":  ["gate"],
    "gate":         ["debate", "test", "developer"],
    "debate":       ["test", "developer"],
    "test":         ["notify", "developer"],
    "notify":       ["archive"],
    "archive":      ["merge"],
    "merge":        [],
}


def _state_dir(issue_iid: int) -> str:
    return os.path.join(TASKS_DIR, f"issue-{issue_iid}")


def _state_file(issue_iid: int) -> str:
    return os.path.join(_state_dir(issue_iid), "pipeline-state.json")


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _read_json(path: str) -> dict:
    with open(path) as f:
        return json.load(f)


def _write_json(path: str, data: dict):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    os.replace(tmp, path)


def cmd_init(issue_iid: int, title: str, criteria: str = ""):
    """Initialize pipeline-state.json for an issue work item."""
    state_file = _state_file(issue_iid)
    if os.path.exists(state_file):
        print(f"[issue-pipeline-state] State already exists for issue !{issue_iid}")
        return

    now = _now_iso()
    stages = {}
    for s in ISSUE_PIPELINE_STAGES:
        stages[s] = {
            "status": "pending",
            "started_at": None,
            "completed_at": None,
            "score": None,
            "details": None,
            "pipeline_id": None,
            "job_id": None,
        }

    pipeline_id = os.environ.get("CI_PIPELINE_ID", "")

    state = {
        "schema_version": 1,
        "issue_iid": issue_iid,
        "change_name": f"issue-{issue_iid}",
        "title": title,
        "acceptance_criteria": criteria,
        "created_at": now,
        "updated_at": now,
        "pipeline_source": "ci",
        "current_stage": "pending",
        "stages": stages,
        "scores": {
            "spec_review": None,
            "code_review": None,
            "debate": None,
        },
        "rework_count": {
            "architect": 0,
            "developer": 0,
            "total": 0,
        },
        "pipeline_ids": [],
        "concerns": [],
        "metrics": {
            "first_stage_started_at": None,
            "last_stage_completed_at": None,
            "total_duration_seconds": None,
        },
    }

    if pipeline_id:
        state["pipeline_ids"].append(int(pipeline_id))

    _write_json(state_file, state)
    print(f"[issue-pipeline-state] Initialized pipeline state for issue !{issue_iid}")


def cmd_update_stage(issue_iid: int, stage: str, status: str,
                     score: int | None = None, details: str | None = None):
    """Update a stage's status in the pipeline state."""
    state_file = _state_file(issue_iid)
    if not os.path.exists(state_file):
        print(f"[issue-pipeline-state] Error: no state file for issue !{issue_iid}. Run init first.",
              file=sys.stderr)
        raise SystemExit(1)

    state = _read_json(state_file)

    if stage not in state["stages"]:
        print(f"[issue-pipeline-state] Error: unknown stage '{stage}'", file=sys.stderr)
        raise SystemExit(1)

    now = _now_iso()
    stage_state = state["stages"][stage]

    if status == "running" and stage_state["status"] == "pending":
        stage_state["started_at"] = now
        if state["metrics"]["first_stage_started_at"] is None:
            state["metrics"]["first_stage_started_at"] = now

    if status in ("completed", "failed", "skipped"):
        stage_state["completed_at"] = now

    stage_state["status"] = status

    if score is not None:
        stage_state["score"] = score
        if stage == "spec-review":
            state["scores"]["spec_review"] = score
        elif stage == "code-review":
            state["scores"]["code_review"] = score
        elif stage == "debate":
            state["scores"]["debate"] = score

    if details:
        stage_state["details"] = details

    pipeline_id = os.environ.get("CI_PIPELINE_ID", "")
    job_id = os.environ.get("CI_JOB_ID", "")
    if pipeline_id:
        stage_state["pipeline_id"] = int(pipeline_id)
        if int(pipeline_id) not in state["pipeline_ids"]:
            state["pipeline_ids"].append(int(pipeline_id))
    if job_id:
        stage_state["job_id"] = int(job_id)

    # Track rework
    if status == "running" and stage_state.get("status_before") == "completed":
        rework_map = {"architect": "architect", "developer": "developer"}
        if stage in rework_map:
            state["rework_count"][rework_map[stage]] += 1
            state["rework_count"]["total"] += 1

    state["current_stage"] = stage
    state["updated_at"] = now

    # Calculate total duration if last stage completed
    if stage == "merge" and status == "completed":
        if state["stages"]["merge"]["completed_at"] and state["metrics"]["first_stage_started_at"]:
            try:
                from datetime import datetime as dt
                start = dt.fromisoformat(state["metrics"]["first_stage_started_at"].replace("Z", "+00:00"))
                end = dt.fromisoformat(state["stages"]["merge"]["completed_at"].replace("Z", "+00:00"))
                state["metrics"]["total_duration_seconds"] = (end - start).total_seconds()
            except (ValueError, OSError):
                pass
    if status in ("completed", "failed") and stage != "pending":
        state["metrics"]["last_stage_completed_at"] = now

    _write_json(state_file, state)
    print(f"[issue-pipeline-state] Stage '{stage}' → {status} for issue !{issue_iid}")


def _color_status(status: str) -> str:
    colors = {
        "completed": "\033[32m",  # green
        "running":   "\033[33m",  # yellow
        "failed":    "\033[31m",  # red
        "skipped":   "\033[90m",  # gray
        "pending":   "\033[37m",  # white
    }
    reset = "\033[0m"
    return f"{colors.get(status, '')}{status}{reset}"


def cmd_show(issue_iid: int, fmt: str = "table"):
    """Display pipeline state for an issue work item."""
    state_file = _state_file(issue_iid)
    if not os.path.exists(state_file):
        print(f"No pipeline state found for issue !{issue_iid}", file=sys.stderr)
        raise SystemExit(1)

    state = _read_json(state_file)

    if fmt == "json":
        print(json.dumps(state, indent=2, ensure_ascii=False))
        return

    # Table format
    print(f"\n{'='*70}")
    print(f"  Issue !{state['issue_iid']}: {state.get('title', 'N/A')}")
    print(f"  Change: {state['change_name']}  |  Current: {state['current_stage']}")
    print(f"{'='*70}\n")

    # Stage table
    print(f"  {'Stage':<16} {'Status':<14} {'Score':<8} {'Duration'}")
    print(f"  {'-'*16} {'-'*14} {'-'*8} {'-'*20}")

    for stage_name in ISSUE_PIPELINE_STAGES:
        s = state["stages"].get(stage_name, {})
        status = s.get("status", "pending")
        score = str(s["score"]) if s.get("score") is not None else "-"
        duration = ""
        if s.get("started_at") and s.get("completed_at"):
            try:
                from datetime import datetime as dt
                start = dt.fromisoformat(s["started_at"].replace("Z", "+00:00"))
                end = dt.fromisoformat(s["completed_at"].replace("Z", "+00:00"))
                secs = (end - start).total_seconds()
                duration = f"{secs:.0f}s"
            except (ValueError, OSError):
                duration = "-"
        elif s.get("started_at") and s["status"] == "running":
            duration = "..."

        # Determine current stage marker
        marker = "→ " if stage_name == state["current_stage"] else "  "
        print(f"  {marker}{stage_name:<14} {_color_status(status):<24} {score:<8} {duration}")

    # Summary
    print(f"\n  {'─'*50}")
    total_rework = state.get("rework_count", {}).get("total", 0)
    spec_score = state.get("scores", {}).get("spec_review")
    code_score = state.get("scores", {}).get("code_review")
    debate_score = state.get("scores", {}).get("debate")

    print(f"  Rework loops: {total_rework}")
    if spec_score is not None:
        print(f"  SPEC review score: {spec_score}")
    if code_score is not None:
        print(f"  Code review score: {code_score}")
    if debate_score is not None:
        print(f"  Debate score: {debate_score}")

    total_dur = state.get("metrics", {}).get("total_duration_seconds")
    if total_dur:
        print(f"  Total duration: {total_dur:.0f}s")

    concerns = state.get("concerns", [])
    if concerns:
        print(f"\n  Concerns ({len(concerns)}):")
        for c in concerns[-5:]:
            print(f"    - [{c.get('stage','?')}] {c.get('message','')[:80]}")

    print()


def cmd_list(status_filter: str | None = None):
    """List all issue pipeline states."""
    if not os.path.isdir(TASKS_DIR):
        print("No tasks directory found")
        return

    entries = []
    for name in sorted(os.listdir(TASKS_DIR)):
        if not name.startswith("issue-"):
            continue
        state_file = os.path.join(TASKS_DIR, name, "pipeline-state.json")
        if not os.path.isfile(state_file):
            continue
        try:
            state = _read_json(state_file)
        except (json.JSONDecodeError, OSError):
            continue

        if status_filter and state.get("current_stage") != status_filter:
            continue

        entries.append(state)

    if not entries:
        print("No issue pipeline states found")
        return

    print(f"\n  {'IID':<6} {'Title':<40} {'Stage':<16} {'Status'}")
    print(f"  {'-'*6} {'-'*40} {'-'*16} {'-'*10}")
    for s in entries:
        iid = s["issue_iid"]
        title = s.get("title", "")[:38]
        stage = s.get("current_stage", "?")
        stage_state = s.get("stages", {}).get(stage, {})
        status = stage_state.get("status", "pending")
        print(f"  !{iid:<5} {title:<40} {stage:<16} {status}")
    print()


def main():
    parser = argparse.ArgumentParser(
        description="issue-pipeline-state — Issue 流水线状态管理",
        prog="issue-pipeline-state.py",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("init", help="初始化流水线状态")
    p.add_argument("issue_iid", type=int)
    p.add_argument("title")
    p.add_argument("--criteria", default="")

    p = sub.add_parser("update-stage", help="更新阶段状态")
    p.add_argument("issue_iid", type=int)
    p.add_argument("stage")
    p.add_argument("status", choices=["pending", "running", "completed", "failed", "skipped"])
    p.add_argument("--score", type=int, default=None)
    p.add_argument("--details", default=None)

    p = sub.add_parser("show", help="查看流水线状态")
    p.add_argument("issue_iid", type=int)
    p.add_argument("--format", default="table", choices=["json", "table"])

    p = sub.add_parser("list", help="列出所有 Issue 流水线状态")
    p.add_argument("--status", default=None)

    args = parser.parse_args()

    match args.command:
        case "init":
            cmd_init(args.issue_iid, args.title, args.criteria)
        case "update-stage":
            cmd_update_stage(args.issue_iid, args.stage, args.status,
                            args.score, args.details)
        case "show":
            cmd_show(args.issue_iid, args.format)
        case "list":
            cmd_list(args.status)
        case _:
            parser.print_help()
            raise SystemExit(1)


if __name__ == "__main__":
    main()
