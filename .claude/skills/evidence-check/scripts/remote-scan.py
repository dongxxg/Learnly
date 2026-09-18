#!/usr/bin/env python3
"""Multi-repo evidence chain audit via GitLab API.

Reads team.json from the daily report repo, then scans each listed repo's
.harness/tasks/ via API, downloading pipeline-state.json files for audit.
"""

import base64
import json
import os
import sys
import urllib.request
import urllib.error
from datetime import datetime, timezone, timedelta
from pathlib import Path

# Import local check module
sys.path.insert(0, str(Path(__file__).resolve().parent))
from check import (
    BEIJING, classify_change, extract_trigger, extract_intent, extract_summary,
    extract_test_report, extract_review_score, extract_tokens, evaluate,
    count_dispatches, flow_allows_na, render_markdown, write_json
)

GL_URL = "http://192.168.5.160"
# Read token from config
config_path = Path(__file__).resolve().parent.parent.parent.parent.parent / ".gitlab-config"
TOKEN = None
if config_path.exists():
    for line in config_path.read_text(encoding="utf-8").splitlines():
        if line.startswith("gitlab_token="):
            TOKEN = line.split("=", 1)[1].strip()
            break


def api_get(path, ref=None):
    """Make a GitLab API GET request. Returns parsed JSON or None."""
    url = f"{GL_URL}/api/v4{path}"
    if ref and "?" not in path:
        url += f"?ref={ref}"
    elif ref:
        url += f"&ref={ref}"
    req = urllib.request.Request(url)
    if TOKEN:
        req.add_header("PRIVATE-TOKEN", TOKEN)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        body = e.read().decode()[:200] if e.fp else ""
        print(f"  API error {e.code}: {body}", file=sys.stderr)
        return None


def list_pipeline_states(project_id, branch):
    """List all pipeline-state.json files in .harness/tasks/ recursively."""
    path = ".harness%2Ftasks"
    data = api_get(f"/projects/{project_id}/repository/tree?path={path}&ref={branch}&recursive=true&per_page=500")
    if not data:
        return []
    return [
        (item["path"], item["path"].split("/")[-2] if item["path"].count("/") >= 2 else None)
        for item in data
        if item.get("type") == "blob" and item["name"] == "pipeline-state.json"
    ]


def download_pipeline_state(project_id, file_path, branch):
    """Download a single pipeline-state.json content."""
    encoded = file_path.replace("/", "%2F")
    data = api_get(f"/projects/{project_id}/repository/files/{encoded}?ref={branch}")
    if not data:
        return None
    return json.loads(base64.b64decode(data["content"]).decode("utf-8"))


def scan_repo_remote(name, project_id, branch, since=None):
    """Scan a repo via GitLab API. Returns (repo_name, results_list)."""
    if TOKEN is None:
        print(f"  [{name}] 无 Token，跳过", file=sys.stderr)
        return name, None

    files = list_pipeline_states(project_id, branch)
    if not files:
        print(f"  [{name}] 无 .harness/tasks/ 目录", file=sys.stderr)
        return name, None

    print(f"  [{name}] 发现 {len(files)} 个 pipeline-state.json", file=sys.stderr)
    results = []

    for file_path, change_name in files:
        if not change_name:
            continue
        if since:
            # Quick date check — we'll do full check after download
            pass

        state = download_pipeline_state(project_id, file_path, branch)
        if state is None:
            print(f"    {change_name}: 下载失败，跳过", file=sys.stderr)
            continue

        # Date filter
        created = state.get("created_at", "")[:10]
        if since and created < since:
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
                "completeness": {"total": 6, "present": 0, "missing": [], "na": [], "pending": []},
                "findings": [],
            })
            continue

        # Build evidence chain (no git fallback for remote — use caller field only)
        trigger = extract_trigger(state, repo_path=None)
        if not trigger["present"]:
            trigger["value"] = "unknown (remote)"
            trigger["source"] = "none"

        evidence = {
            "trigger_source": trigger,
            "intent_gate": extract_intent(state),
            "change_summary": extract_summary(state),
            "test_report": extract_test_report(state),
            "review_score": extract_review_score(state),
            "token_consumption": extract_tokens(state),
        }

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
            "evidence_chain": {k: {"present": v["present"], "value": v["value"], "source": v["source"]}
                              for k, v in evidence.items()},
            "completeness": completeness,
            "findings": findings,
        })

    return name, results


def project_id_from_url(url):
    """Convert a GitLab repo URL to a URL-encoded project ID.
    e.g. http://192.168.5.160/UniData/backend/foo.git -> UniData%2Fbackend%2Ffoo
    """
    path = url.replace(f"{GL_URL}/", "").replace(".git", "")
    return path.replace("/", "%2F")


def fetch_team_json():
    """Fetch team.json from daily report repo."""
    return api_get(
        f"/projects/public_group%2Fdaily_report/repository/files/config%2Fteam.json?ref=dev"
    )


def main():
    since = None
    if len(sys.argv) > 1:
        if sys.argv[1] == "--since" and len(sys.argv) > 2:
            since = sys.argv[2]
        elif sys.argv[1] == "--all":
            since = None

    if not since:
        since = datetime.now().strftime("%Y-%m-%d")

    print(f"[remote-scan] 拉取 team.json...", file=sys.stderr)
    team_raw = fetch_team_json()
    if not team_raw:
        print("无法获取 team.json", file=sys.stderr)
        return 1

    import base64
    team = json.loads(base64.b64decode(team_raw["content"]).decode("utf-8"))
    repos = team.get("repos", [])

    print(f"[remote-scan] {len(repos)} 个仓库, since={since}", file=sys.stderr)

    output_dir = Path(os.getcwd()) / ".harness" / "audit"
    all_data = []

    for repo in repos:
        name = repo["name"]
        branch = repo["branch"]
        pid = project_id_from_url(repo["url"])
        print(f"[remote-scan] 扫描: {name} ({branch})", file=sys.stderr)

        rn, results = scan_repo_remote(name, pid, branch, since)
        if results is None:
            all_data.append((rn, None))
            continue
        all_data.append((rn, results))

        # Per-repo output
        write_json(rn, results, str(output_dir), since)
        md = render_markdown(rn, results, since)
        (output_dir / f"{rn}.md").write_text(md, encoding="utf-8")
        print(f"  -> {rn}.json, {rn}.md ({len(results)} changes)", file=sys.stderr)

    # Merged report
    business_all = []
    for rn, results in all_data:
        if results:
            business_all.extend(r for r in results if r["classification"] == "business")

    ts = datetime.now(BEIJING).strftime("%Y%m%d-%H%M%S")

    # Build merged markdown
    lines = []
    w = lines.append
    w("# 证据链合规审计 — 多仓汇总")
    w("")
    w(f"> 审计时间：{datetime.now(BEIJING).strftime('%Y-%m-%d %H:%M:%S')}+08:00")
    w(f"> 审计范围：{since} — {len(repos)} 个仓库")
    w(f"> 审计标准：630 unified spec §11.1 — 6 字段证据链")
    w("")
    w("---")
    w("")
    w("## 总览")
    w("")
    w("| 仓库 | Changes | 业务 MR | Pass | 进行中 | Block | N/A | 合规率 |")
    w("|------|:-----:|:-----:|:----:|:---:|:-----:|:---:|:---:|")

    for rn, results in all_data:
        if results is None:
            w(f"| {rn} | — | — | — | — | — | — | 无框架安装 |")
            continue
        biz = [r for r in results if r["classification"] == "business"]
        n = len(biz)
        n_pass = sum(1 for r in biz if r["audit_result"] == "pass")
        n_prog = sum(1 for r in biz if r["audit_result"] == "in_progress")
        n_block = sum(1 for r in biz if r["audit_result"] == "block")
        n_na = sum(1 for r in results if r["audit_result"] == "na")
        rate = f"{round(n_pass/n*100)}%" if n else "—"
        w(f"| {rn} | {len(results)} | {n} | {n_pass} | {n_prog} | {n_block} | {n_na} | {rate} |")

    n_total_biz = sum(1 for r in business_all)
    n_total_pass = sum(1 for r in business_all if r["audit_result"] == "pass")
    n_total_block = sum(1 for r in business_all if r["audit_result"] == "block")
    total_rate = f"{round(n_total_pass/n_total_biz*100)}%" if n_total_biz else "—"
    w(f"| **合计** | | **{n_total_biz}** | **{n_total_pass}** | | **{n_total_block}** | | **{total_rate}** |")
    w("")
    w("---")
    w("")
    w("## 各仓 Block 项")
    w("")

    blocks = [r for r in business_all if r["audit_result"] == "block"]
    if blocks:
        for r in blocks:
            # find which repo
            for rn, results in all_data:
                if results and r in results:
                    w(f"- `{rn}` / `{r['change_name']}` — {', '.join(r['completeness']['missing'])} 缺失")
                    break
    else:
        w("无阻断项 ✅")
    w("")

    merged_md = "\n".join(lines)
    (output_dir / f"merged-{ts}.md").write_text(merged_md, encoding="utf-8")

    # Print summary
    print(f"\n{'='*60}")
    print(f"多仓汇总: {len(repos)} 仓库, {n_total_biz} 业务 MR, 合规率 {total_rate}")
    print(f"报告: {output_dir}/merged-{ts}.md")
    print(f"{'='*60}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
