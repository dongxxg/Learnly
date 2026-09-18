#!/usr/bin/env python3
"""AI MR compliance evidence chain audit.

Scans pipeline-state.json files under .harness/tasks/ and checks
the 6-field evidence chain per 630 unified spec section 11.1:
  trigger_source → intent_gate → change_summary → test_report → review_score → token_consumption

Usage:
  python3 check.py                          # current repo, today onwards
  python3 check.py --all                    # current repo, all changes
  python3 check.py --since 2026-06-10       # current repo, date filter
  python3 check.py --repo /path/to/repo     # single other repo
  python3 check.py --repos /a,/b,/c         # multiple repos
  python3 check.py --discover               # auto-discover sibling repos
"""

import argparse
import json
import os
import subprocess
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path

BEIJING = timezone(timedelta(hours=8))

# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def parse_args():
    p = argparse.ArgumentParser(description="AI MR compliance evidence chain audit")
    # mode
    g = p.add_mutually_exclusive_group()
    g.add_argument("--repo", help="Scan a single specified repo")
    g.add_argument("--repos", help="Scan multiple repos (comma-separated paths)")
    g.add_argument("--discover", action="store_true", help="Auto-discover repos under parent dir")
    # filters
    p.add_argument("--all", action="store_true", help="Scan all changes (no date filter)")
    p.add_argument("--since", help="Only scan changes created on or after this date (YYYY-MM-DD)")
    # output
    p.add_argument("--output-dir", help="Output directory (default: .harness/audit/)")
    p.add_argument("--quiet", action="store_true", help="Suppress progress messages")
    return p.parse_args()


# ---------------------------------------------------------------------------
# Filesystem helpers
# ---------------------------------------------------------------------------

def find_tasks_root(repo_path):
    """Return .harness/tasks/ path inside a repo, or None."""
    root = Path(repo_path) / ".harness" / "tasks"
    return root if root.is_dir() else None


def discover_changes(tasks_root, since=None):
    """Yield (change_name, path) for each pipeline-state.json under tasks_root.

    Excludes the `archive/` sub-directory scan — archive is still scanned
    because archived changes *are* valid audit subjects.
    """
    for ps_path in sorted(tasks_root.rglob("pipeline-state.json")):
        change_name = ps_path.parent.name
        if since and change_created_at(ps_path) < since:
            continue
        yield change_name, ps_path


def change_created_at(ps_path):
    """Extract created_at from a pipeline-state.json file quickly."""
    try:
        data = json.loads(ps_path.read_text(encoding="utf-8"))
        return data.get("created_at", "")[:10]
    except Exception:
        return ""


def repo_name(repo_path):
    return Path(repo_path).resolve().name


# ---------------------------------------------------------------------------
# JSON loading
# ---------------------------------------------------------------------------

def load_pipeline_state(path):
    """Load pipeline-state.json, return dict or None on failure."""
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Classification
# ---------------------------------------------------------------------------

def count_dispatches(state):
    """Sum dispatch_history entries across all pipeline phases."""
    total = 0
    pipeline = state.get("pipeline") or {}
    for phase_name, phase in pipeline.items():
        if not isinstance(phase, dict):
            continue
        total += len(phase.get("dispatch_history") or [])
    return total


def is_e2e_name(name):
    return "e2e" in (name or "").lower()


def classify_change(state, change_name):
    """Return (category, reason).

    category ∈ {business, ci_driven, not_started}
    """
    dispatch_count = count_dispatches(state)
    current_phase = state.get("current_phase", "")

    if dispatch_count == 0 and is_e2e_name(change_name):
        return "ci_driven", "CI/E2E 驱动，无 AI dispatch 记录"
    if current_phase == "pending" and dispatch_count == 0:
        return "not_started", "从未启动（pending + 无 dispatch）"
    return "business", "有 AI dispatch 记录"


# ---------------------------------------------------------------------------
# 6-field extraction
# ---------------------------------------------------------------------------

def extract_trigger(state, repo_path):
    """Extract trigger source: caller field (v6) or git log fallback."""
    caller = state.get("caller") or state.get("initiated_by")
    if caller:
        return {"present": True, "value": caller, "source": "caller"}

    # git fallback
    try:
        r = subprocess.run(
            ["git", "-C", repo_path, "log", "-1", "--format=%an"],
            capture_output=True, text=True, timeout=5
        )
        if r.returncode == 0 and r.stdout.strip():
            return {"present": True, "value": r.stdout.strip(), "source": "git-log"}
    except Exception:
        pass

    return {"present": False, "value": None, "source": None}


def extract_intent(state):
    intake = (state.get("pipeline") or {}).get("intake") or {}
    status = intake.get("status")
    exit_s = intake.get("exit_status", "N/A")
    if status is not None:
        return {"present": True, "value": f"{status} ({exit_s})", "source": "pipeline.intake"}
    return {"present": False, "value": None, "source": None}


def extract_summary(state):
    intake = (state.get("pipeline") or {}).get("intake") or {}
    summary = intake.get("summary")
    if summary:
        return {"present": True, "value": summary[:200], "source": "pipeline.intake.summary"}
    title = state.get("title") or state.get("description")
    if title:
        return {"present": True, "value": title[:200], "source": "title"}
    return {"present": False, "value": None, "source": None}


def extract_test_report(state):
    """Detect tester involvement.

    v6 schema: independent `test` phase with status == done.
    Old schema: `apply` phase with >= 2 dispatches (dev + tester).
    """
    pipeline = state.get("pipeline") or {}

    # v6: independent test phase
    test = pipeline.get("test") or {}
    if isinstance(test, dict):
        dispatches = test.get("dispatch_history") or []
        has_test_dispatch = len(dispatches) >= 1
        test_done = test.get("status") == "done" or test.get("exit_status") == "DONE"
        # Accept: status=done (even 0 dispatches, e.g. auto-completed)
        #      or exit_status=DONE with dispatches (ran but status not finalized)
        if test.get("status") == "done" or (test.get("exit_status") == "DONE" and has_test_dispatch):
            return {"present": True, "value": "独立 test phase", "source": "pipeline.test"}

    # old schema: apply phase >= 2 dispatches
    apply = pipeline.get("apply") or {}
    if isinstance(apply, dict):
        dispatches = apply.get("dispatch_history") or []
        if len(dispatches) >= 2:
            return {"present": True, "value": f"apply phase ({len(dispatches)} dispatches)", "source": "pipeline.apply"}

    return {"present": False, "value": None, "source": None}


def extract_review_score(state):
    scores = state.get("scores") or {}
    score = scores.get("reviewer") or scores.get("review")
    if score is not None:
        return {"present": True, "value": score, "source": "scores.reviewer"}
    # code-review phase
    cr = (state.get("pipeline") or {}).get("code-review") or {}
    if isinstance(cr, dict) and cr.get("score") is not None:
        return {"present": True, "value": cr["score"], "source": "pipeline.code-review.score"}
    # Legacy 兜底（!168 的 state.scores 回填机制 8 月才上线，7 月及以前的 change
    # scores.reviewer 恒为 None，但 dispatch_history[].score 当时已由 mark-dispatch
    # --score 写入）：取 code-review / design-review 记录到的最高分作为评审证据。
    for phase_key in ("code-review", "design-review"):
        ph = (state.get("pipeline") or {}).get(phase_key) or {}
        hist = ph.get("dispatch_history") if isinstance(ph, dict) else None
        vals = [h.get("score") for h in (hist or []) if isinstance(h, dict) and h.get("score") is not None]
        if vals:
            return {"present": True, "value": max(vals), "source": f"dispatch_history.{phase_key}.legacy"}
    return {"present": False, "value": None, "source": None}


def extract_tokens(state):
    """Recursively sum token_usage across all dispatch_history entries."""
    total = {"input": 0, "output": 0, "cache_read": 0}
    pipeline = state.get("pipeline") or {}
    for phase_name, phase in pipeline.items():
        if not isinstance(phase, dict):
            continue
        for dh in (phase.get("dispatch_history") or []):
            tu = dh.get("token_usage") or {}
            total["input"] += tu.get("input_tokens", 0)
            total["output"] += tu.get("output_tokens", 0)
            total["cache_read"] += tu.get("cache_read_input_tokens", 0)
    has_tokens = total["input"] > 0 or total["output"] > 0
    return {
        "present": has_tokens,
        "value": total if has_tokens else None,
        "source": "dispatch_history" if has_tokens else None,
    }


# ---------------------------------------------------------------------------
# Flow type awareness
# ---------------------------------------------------------------------------

FIELDS_NA_ALLOWED = {
    # flow_type -> set of fields that can be N/A without being a defect
    "quick": {"test_report", "review_score"},
    "hotfix": {"test_report"},
    "docs": {"test_report"},
    # config-change 的 pipeline map 无 test 阶段（state-store.js 结构事实），
    # test_report 属结构性 N/A，非证据缺失；review 在链上（code-review），不豁免
    "config-change": {"test_report"},
}


def flow_allows_na(flow_type, field):
    allowed = FIELDS_NA_ALLOWED.get(flow_type, set())
    return field in allowed


# ---------------------------------------------------------------------------
# Evaluation
# ---------------------------------------------------------------------------

def build_evidence_chain(state, repo_path):
    return {
        "trigger_source": extract_trigger(state, repo_path),
        "intent_gate": extract_intent(state),
        "change_summary": extract_summary(state),
        "test_report": extract_test_report(state),
        "review_score": extract_review_score(state),
        "token_consumption": extract_tokens(state),
    }


# Field → pipeline phase that must have been reached for the field to be expected
FIELD_PHASE_MAP = {
    "test_report": "test",
    "review_score": "code-review",
}


def phase_is_pending(state, field):
    """Check if a missing field is because the pipeline phase hasn't started yet."""
    phase_name = FIELD_PHASE_MAP.get(field)
    if not phase_name:
        return False
    pipeline = state.get("pipeline") or {}
    if phase_name not in pipeline:
        return False  # phase doesn't exist at all → not pending, it's missing
    phase = pipeline[phase_name]
    if not isinstance(phase, dict):
        return False
    return phase.get("status") in ("pending", None)


def evaluate(evidence, flow_type, state=None):
    """Return (result, findings, completeness).

    result: pass | in_progress | block
    - pass: all fields present or N/A
    - in_progress: missing fields are from phases not yet reached
    - block: missing fields from phases that should have been done
    """
    findings = []
    missing = []
    na_fields = []
    pending_fields = []

    for field, info in evidence.items():
        if info["present"]:
            continue
        if flow_allows_na(flow_type, field):
            na_fields.append(field)
        elif state and phase_is_pending(state, field):
            pending_fields.append(field)
        else:
            missing.append(field)
            findings.append({
                "field": field,
                "severity": "P1",
                "description": f"{field} 缺失",
                "recommendation": "补齐 pipeline-state.json 对应字段",
            })

    effective_present = 6 - len(missing) - len(na_fields) - len(pending_fields)

    if not missing and not pending_fields:
        return "pass", findings, {
            "total": 6, "present": effective_present,
            "missing": [], "na": na_fields, "pending": [],
        }
    if not missing and pending_fields:
        return "in_progress", findings, {
            "total": 6, "present": effective_present,
            "missing": [], "na": na_fields, "pending": pending_fields,
        }
    return "block", findings, {
        "total": 6, "present": effective_present,
        "missing": missing, "na": na_fields, "pending": pending_fields,
    }


# ---------------------------------------------------------------------------
# Single repo scan
# ---------------------------------------------------------------------------

def scan_repo(repo_path, since=None, output_dir=None):
    """Scan a single repo. Returns (repo_name, results_list)."""
    tasks_root = find_tasks_root(repo_path)
    if not tasks_root:
        print(f"[evidence-check] {repo_path}: 无 .harness/tasks/ 目录，跳过", file=sys.stderr)
        return repo_name(repo_path), None

    results = []

    for change_name, ps_path in discover_changes(tasks_root, since):
        state = load_pipeline_state(ps_path)
        if state is None:
            print(f"[evidence-check] {change_name}: pipeline-state.json 损坏，跳过", file=sys.stderr)
            continue

        category, reason = classify_change(state, change_name)
        flow_type = state.get("flow_type", "")

        if category != "business":
            results.append({
                "change_name": change_name,
                "title": (state.get("title") or "")[:120],
                "audit_result": "na",
                "classification": category,
                "flow_type": flow_type,
                "current_phase": state.get("current_phase", ""),
                "created_at": state.get("created_at", ""),
                "dispatch_count": count_dispatches(state),
                "evidence_chain": {},
                "completeness": {"total": 6, "present": 0, "missing": [], "na": []},
                "findings": [],
            })
            continue

        evidence = build_evidence_chain(state, repo_path)
        result, findings, completeness = evaluate(evidence, flow_type, state)

        results.append({
            "change_name": change_name,
            "title": (state.get("title") or "")[:120],
            "audit_result": result,
            "classification": category,
            "flow_type": flow_type,
            "current_phase": state.get("current_phase", ""),
            "created_at": state.get("created_at", ""),
            "dispatch_count": count_dispatches(state),
            "evidence_chain": {k: {
                "present": v["present"],
                "value": v["value"],
                "source": v["source"],
            } for k, v in evidence.items()},
            "completeness": completeness,
            "findings": findings,
        })

    if not results:
        print(f"[evidence-check] {repo_path}: 无匹配的 change", file=sys.stderr)

    return repo_name(repo_path), results


# ---------------------------------------------------------------------------
# JSON output
# ---------------------------------------------------------------------------

def write_json(repo_name, results, output_dir, since):
    out_dir = Path(output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    business = [r for r in results if r["classification"] == "business"]
    n = len(business)
    n_pass = sum(1 for r in business if r["audit_result"] == "pass")
    n_block = sum(1 for r in business if r["audit_result"] == "block")
    n_na = sum(1 for r in results if r["audit_result"] == "na")

    report = {
        "repo": repo_name,
        "audit_time": datetime.now(BEIJING).isoformat(),
        "since": since or "all",
        "summary": {
            "total": len(results),
            "business": n,
            "pass": n_pass,
            "block": n_block,
            "na": n_na,
            "compliance_rate": round(n_pass / n, 2) if n else None,
        },
        "changes": results,
    }

    path = out_dir / f"{repo_name}.json"
    tmp = out_dir / f"{repo_name}.json.tmp"
    tmp.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


# ---------------------------------------------------------------------------
# Markdown output
# ---------------------------------------------------------------------------

def render_markdown(repo_name, results, since):
    lines = []
    w = lines.append

    business = [r for r in results if r["classification"] == "business"]
    n = len(business)
    n_pass = sum(1 for r in business if r["audit_result"] == "pass")
    n_progress = sum(1 for r in business if r["audit_result"] == "in_progress")
    n_block = sum(1 for r in business if r["audit_result"] == "block")
    n_na = sum(1 for r in results if r["audit_result"] == "na")

    total_input = 0
    total_output = 0
    total_cache = 0
    n_scored = 0
    total_score = 0
    for r in business:
        ec = r.get("evidence_chain") or {}
        tok = ec.get("token_consumption") or {}
        if isinstance(tok.get("value"), dict):
            total_input += tok["value"].get("input", 0)
            total_output += tok["value"].get("output", 0)
            total_cache += tok["value"].get("cache_read", 0)
        rs = ec.get("review_score") or {}
        if isinstance(rs.get("value"), (int, float)):
            n_scored += 1
            total_score += rs["value"]

    w(f"# 证据链合规审计 — {repo_name}")
    w("")
    w(f"> 审计时间：{datetime.now(BEIJING).strftime('%Y-%m-%d %H:%M:%S')}+08:00")
    w(f"> 审计范围：{since or '全部'}")
    w(f"> 审计标准：630 unified spec §11.1 — 6 字段证据链")
    w("")
    w("---")
    w("")
    w("## 1. 摘要")
    w("")
    w(f"| 指标 | 值 |")
    w(f"|------|----|")
    w(f"| 总 Change 数 | {len(results)} |")
    w(f"| 业务 MR | {n} |")
    w(f"| Pass | {n_pass} |")
    w(f"| 进行中 | {n_progress} |")
    w(f"| Block | {n_block} |")
    w(f"| N/A | {n_na} |")
    w(f"| 合规率 | {round(n_pass/n*100) if n else 0}% |")
    if n_scored:
        w(f"| 平均 Review 评分 | {total_score/n_scored:.1f} (n={n_scored}) |")
    w(f"| Token 消耗 | input={total_input:,} output={total_output:,} cache_read={total_cache:,} |")
    w("")
    w("---")
    w("")
    w("## 2. 明细")
    w("")

    for r in sorted(results, key=lambda x: (x["classification"], x["change_name"])):
        if r["classification"] != "business":
            continue
        icons = {"pass": "✅", "in_progress": "🟡", "block": "🔴", "na": "⚪"}
        icon = icons.get(r["audit_result"], "⚪")
        w(f"### {icon} `{r['change_name']}`")
        w("")
        w(f"| # | 字段 | 值 | 状态 |")
        w(f"|---|------|----|:--:|")
        ec = r.get("evidence_chain") or {}
        field_names = [
            ("1. 触发来源", "trigger_source"),
            ("2. 意图门禁", "intent_gate"),
            ("3. 变更摘要", "change_summary"),
            ("4. 测试报告", "test_report"),
            ("5. Review 评分", "review_score"),
            ("6. Token 消费", "token_consumption"),
        ]
        for label, key in field_names:
            info = ec.get(key) or {}
            val = info.get("value")
            present = info.get("present")
            if key == "token_consumption" and present and isinstance(val, dict):
                val_str = f"in={val['input']:,} out={val['output']:,} cache={val['cache_read']:,}"
            elif not present:
                na_fields = r.get("completeness", {}).get("na", [])
                val_str = "N/A" if key in na_fields else "—"
            else:
                val_str = str(val)[:120] if val is not None else "—"
            status = "✅" if present else ("⚪ N/A" if key in r.get("completeness", {}).get("na", []) else "❌")
            w(f"| {label} | {val_str} | {status} |")
        w("")
        w(f"> phase=`{r['current_phase']}` | flow=`{r['flow_type']}` | dispatches={r['dispatch_count']} | created={r['created_at'][:10]}")
        w("")

    # non-business
    na_list = [r for r in results if r["classification"] != "business"]
    if na_list:
        w("---")
        w("")
        w("## 3. 非业务 MR（不适用）")
        w("")
        for r in sorted(na_list, key=lambda x: x["change_name"]):
            w(f"- `{r['change_name']}` — {r['classification']} | {r['current_phase']}")
        w("")

    # findings
    blocks = [r for r in business if r["audit_result"] == "block"]
    if blocks:
        w("---")
        w("")
        w("## 4. 待补齐项")
        w("")
        for r in blocks:
            for f in r.get("findings", []):
                w(f"- `{r['change_name']}` — **{f['field']}**: {f['description']}")
        w("")

    return "\n".join(lines)


def write_markdown(repo_name, results, since, output_dir):
    md = render_markdown(repo_name, results, since)
    out_dir = Path(output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"{repo_name}.md"
    path.write_text(md, encoding="utf-8")
    return md


# ---------------------------------------------------------------------------
# Multi-repo merge
# ---------------------------------------------------------------------------

def write_merged_json(all_repo_data, output_dir, since):
    """all_repo_data: list of (repo_name, results) tuples."""
    out_dir = Path(output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    ts = datetime.now(BEIJING).strftime("%Y%m%d-%H%M%S")

    repos_summary = []
    for repo_name, results in all_repo_data:
        business = [r for r in (results or []) if r["classification"] == "business"]
        repos_summary.append({
            "repo": repo_name,
            "total": len(results or []),
            "business": len(business),
            "pass": sum(1 for r in business if r["audit_result"] == "pass"),
            "block": sum(1 for r in business if r["audit_result"] == "block"),
            "na": sum(1 for r in (results or []) if r["audit_result"] == "na"),
        })

    merged = {
        "audit_time": datetime.now(BEIJING).isoformat(),
        "since": since or "all",
        "repos": repos_summary,
        "details": {rn: results for rn, results in all_repo_data},
    }

    path = out_dir / f"merged-{ts}.json"
    tmp = out_dir / f"merged-{ts}.json.tmp"
    tmp.write_text(json.dumps(merged, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)
    return str(path), ts


def write_merged_markdown(all_repo_data, output_dir, since, ts):
    out_dir = Path(output_dir)
    lines = []
    w = lines.append

    w("# 证据链合规审计 — 多仓汇总")
    w("")
    w(f"> 审计时间：{datetime.now(BEIJING).strftime('%Y-%m-%d %H:%M:%S')}+08:00")
    w(f"> 审计范围：{since or '全部'}")
    w("")
    w("---")
    w("")
    w("## 总览")
    w("")
    w("| 仓库 | Changes | Pass | Block | N/A | 合规率 |")
    w("|------|:-----:|:----:|:-----:|:---:|:---:|")

    for repo_name, results in all_repo_data:
        business = [r for r in (results or []) if r["classification"] == "business"]
        n_biz = len(business)
        n_pass = sum(1 for r in business if r["audit_result"] == "pass")
        n_block = sum(1 for r in business if r["audit_result"] == "block")
        n_na = sum(1 for r in (results or []) if r["audit_result"] == "na")
        rate = f"{round(n_pass/n_biz*100)}%" if n_biz else "—"
        w(f"| {repo_name} | {len(results or [])} | {n_pass} | {n_block} | {n_na} | {rate} |")

    w("")
    w("---")
    w("")
    w("## 各仓明细")
    w("")

    for repo_name, results in all_repo_data:
        w(f"### {repo_name}")
        w("")
        if results is None:
            w("无 .harness/tasks/ 目录")
            w("")
            continue
        if not results:
            w("无匹配 change")
            w("")
            continue
        md = render_markdown(repo_name, results, since)
        w(md)
        w("")

    path = out_dir / f"merged-{ts}.md"
    path.write_text("\n".join(lines), encoding="utf-8")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Repo discovery
# ---------------------------------------------------------------------------

def discover_repos():
    """Walk up from PWD, then look for sibling dirs with .harness/tasks/."""
    cwd = Path.cwd()
    # look up to two levels above for parent of repos
    candidates = set()
    for base in [cwd.parent, cwd.parent.parent, cwd]:
        if not base:
            continue
        for entry in base.iterdir():
            if entry.is_dir() and (entry / ".harness" / "tasks").is_dir():
                candidates.add(str(entry.resolve()))
    return sorted(candidates)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    args = parse_args()
    if args.since:
        since = args.since
    elif args.all:
        since = None
    else:
        since = datetime.now().strftime("%Y-%m-%d")

    if args.repo:
        # Single specified repo
        repo_paths = [args.repo]
        output_base = args.output_dir or os.path.join(args.repo, ".harness", "audit")
    elif args.repos:
        repo_paths = [p.strip() for p in args.repos.split(",") if p.strip()]
        output_base = args.output_dir or os.path.join(os.getcwd(), ".harness", "audit")
    elif args.discover:
        repo_paths = discover_repos()
        if not repo_paths:
            print("[evidence-check] 未发现含 .harness/tasks/ 的仓库", file=sys.stderr)
            return 0
        output_base = args.output_dir or os.path.join(os.getcwd(), ".harness", "audit")
    else:
        # Default: current repo
        repo_paths = [os.getcwd()]
        output_base = args.output_dir or os.path.join(os.getcwd(), ".harness", "audit")

    if not args.quiet:
        print(f"[evidence-check] 扫描 {len(repo_paths)} 个仓库，since={since}")

    all_data = []
    for rp in repo_paths:
        if not args.quiet:
            print(f"[evidence-check] 扫描: {rp}")
        rn, results = scan_repo(rp, since=since)
        if results is None:
            all_data.append((rn, None))
            continue
        all_data.append((rn, results))

        # Per-repo output: go to that repo's .harness/audit/
        if args.repo or len(repo_paths) == 1:
            # single repo mode: output in that repo
            repo_out = args.output_dir or os.path.join(rp, ".harness", "audit")
        else:
            # multi-repo mode: each repo's output in its own dir
            repo_out = os.path.join(rp, ".harness", "audit")

        write_json(rn, results, repo_out, since)
        md = write_markdown(rn, results, since, repo_out)
        md_path = os.path.join(repo_out, f"{rn}.md")
        if not args.quiet:
            print(f"  -> {rn}.json, {rn}.md")

    # Multi-repo merge
    if len(repo_paths) > 1:
        merged_json, ts = write_merged_json(all_data, output_base, since)
        merged_md = write_merged_markdown(all_data, output_base, since, ts)
        if not args.quiet:
            print(f"[evidence-check] 汇总: merged-{ts}.json, merged-{ts}.md")

    return 0


if __name__ == "__main__":
    sys.exit(main())
