#!/usr/bin/env python3
"""ci-bridge — Agent 产出物流转桥接（GitLab API 封装）

用法:
  ci-bridge.py merge-mr <mr_iid>
  ci-bridge.py create-mr --source=<branch> --target=<branch> --title=<title> [--labels=<labels>] [--issue-iid=<iid>]
  ci-bridge.py update-issue-label <issue_iid> --add=<labels> --remove=<labels> [--trigger-next] [--extra-vars=<k=v,...>]
  ci-bridge.py add-note <issue_iid> --message=<msg>
  ci-bridge.py add-structured-note <issue_iid> --message=<msg> --event=<event> --stage=<stage> [--metadata=<json>]
  ci-bridge.py close-issue <issue_iid> --comment=<msg>
  ci-bridge.py close-mr <mr_iid>
  ci-bridge.py list-issue-mrs <issue_iid> [--state=<state>]
  ci-bridge.py transition-spec <spec_meta_path> <new_status>

仅依赖 Python stdlib，无需外部包。
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import subprocess
import sys
import time
import typing
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone


# ─── Label → Pipeline Role 映射 ───

LABEL_TRIGGERS = {
    "ai-todo": "architect",
    "ai-spec-rework": "architect",
    "ai-code-rework": "developer",
    "ai-spec-review": "reviewer",
    "ai-develop": "developer",
    "ai-code-review": "reviewer",
    "ai-testing": "tester",
}


# ─── GitLab API 客户端 ───

class GitlabClient:
    """封装 GitLab API v4 调用，含重试、审计日志。"""

    def __init__(self):
        self.url = os.environ.get("CI_API_V4_URL", "https://gitlab.com/api/v4")
        self.token = os.environ.get("GITLAB_TOKEN", "")
        self.project_id = os.environ.get("CI_PROJECT_ID", "")
        self.audit_log_path = os.environ.get("CI_PROJECT_DIR", ".") + "/bridge-audit.log"

    def _audit(self, action: str, target: str, result: str):
        ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        line = f"[{ts}] ACTION={action} TARGET={target} RESULT={result}\n"
        try:
            with open(self.audit_log_path, "a") as f:
                f.write(line)
        except OSError:
            pass

    def _request(self, method: str, path: str, data: dict | None = None,
                 timeout: int = 30, retries: int = 3) -> tuple[int, typing.Any]:
        """发送 API 请求，返回 (http_code, parsed_body)。"""
        if not self.token:
            raise SystemExit(f"[ci-bridge] Error: GITLAB_TOKEN is required")

        url = f"{self.url}/projects/{self.project_id}{path}"
        body = json.dumps(data).encode() if data else None

        last_error = None
        for attempt in range(1, retries + 1):
            try:
                req = urllib.request.Request(url, data=body, method=method)
                req.add_header("PRIVATE-TOKEN", self.token)
                req.add_header("Content-Type", "application/json")
                req.add_header("User-Agent", "ci-bridge/1.0")

                with urllib.request.urlopen(req, timeout=timeout) as resp:
                    raw = resp.read().decode()
                    try:
                        return resp.status, json.loads(raw)
                    except json.JSONDecodeError:
                        return resp.status, raw

            except urllib.error.HTTPError as e:
                last_error = e
                if attempt < retries:
                    time.sleep(min(5 * attempt, 15))
            except OSError as e:
                last_error = e
                if attempt < retries:
                    time.sleep(min(5 * attempt, 15))

        if isinstance(last_error, urllib.error.HTTPError):
            body_text = last_error.read().decode()[:500] if last_error.fp else ""
            return last_error.code, body_text
        raise SystemExit(f"[ci-bridge] Error: API request failed after {retries} retries: {last_error}")

    def get_issue(self, iid: int) -> dict:
        _, data = self._request("GET", f"/issues/{iid}")
        if not isinstance(data, dict):
            raise SystemExit(f"[ci-bridge] Error: unexpected API response for issue !{iid}")
        return data

    def get_issue_labels(self, iid: int) -> list[str]:
        return self.get_issue(iid).get("labels", [])

    def update_issue(self, iid: int, data: dict):
        return self._request("PUT", f"/issues/{iid}", data)

    def get_mr(self, mr_iid: int) -> dict:
        _, data = self._request("GET", f"/merge_requests/{mr_iid}")
        if not isinstance(data, dict):
            raise SystemExit(f"[ci-bridge] Error: unexpected API response for MR !{mr_iid}")
        return data

    def create_mr(self, data: dict) -> tuple[int, dict]:
        code, resp = self._request("POST", "/merge_requests", data)
        if not isinstance(resp, dict):
            return code, {}
        return code, resp

    def merge_mr(self, mr_iid: int, remove_source: bool = True) -> tuple[int, typing.Any]:
        return self._request("PUT", f"/merge_requests/{mr_iid}/merge",
                             {"should_remove_source_branch": remove_source})

    def close_mr(self, mr_iid: int) -> tuple[int, typing.Any]:
        return self._request("PUT", f"/merge_requests/{mr_iid}",
                             {"state_event": "close"})

    def list_mrs(self, params: dict | None = None) -> list[dict]:
        qs = ""
        if params:
            parts = [f"{k}={urllib.parse.quote(str(v))}" for k, v in params.items()]
            qs = "?" + "&".join(parts)
        _, data = self._request("GET", f"/merge_requests{qs}")
        if isinstance(data, list):
            return data
        return []

    def add_note(self, iid: int, body: str, rd_metadata: dict | None = None):
        if rd_metadata:
            meta_json = json.dumps(rd_metadata, ensure_ascii=False, indent=2)
            body = f"{body}\n\n<!-- rd_harness:metadata\n{meta_json}\n-->"
        return self._request("POST", f"/issues/{iid}/notes", {"body": body})

    def close_issue(self, iid: int) -> tuple[int, typing.Any]:
        return self._request("PUT", f"/issues/{iid}", {"state_event": "close"})

    def trigger_pipeline(self, ref: str, variables: list[dict]) -> tuple[int, dict]:
        return self._request("POST", "/pipeline",
                             {"ref": ref, "variables": variables})


# ─── 日志 ───

def setup_logging():
    logging.basicConfig(
        level=logging.INFO,
        format="[ci-bridge] %(message)s",
        stream=sys.stderr,
    )


# ─── 子命令实现 ───

def cmd_merge_mr(client: GitlabClient, args: argparse.Namespace):
    mr_iid = args.mr_iid
    mr = client.get_mr(mr_iid)
    state = mr.get("state", "unknown")

    if state == "merged":
        print(f"[ci-bridge] MR !{mr_iid} already merged")
        client._audit("merge-mr", f"MR#{mr_iid}", "already_merged")
        return

    # Strip WIP/Draft prefix
    title = mr.get("title", "")
    if title.startswith("WIP:") or title.startswith("Draft:"):
        clean = title.removeprefix("WIP: ").removeprefix("WIP:").removeprefix("Draft: ").removeprefix("Draft:")
        client._request("PUT", f"/merge_requests/{mr_iid}", {"title": clean})
        print(f"[ci-bridge] Removed WIP/Draft prefix")

    for attempt in range(1, 4):
        code, _resp = client.merge_mr(mr_iid)
        if 200 <= code < 300:
            print(f"[ci-bridge] Merged MR !{mr_iid}")
            client._audit("merge-mr", f"MR#{mr_iid}", "success")
            return

        if code in (405, 409):
            print(f"[ci-bridge] MR !{mr_iid} merge conflict (HTTP {code})", file=sys.stderr)
            desc = mr.get("description", "")
            linked_issue = None
            import re
            m = re.search(r'Closes #(\d+)', desc)
            if m:
                linked_issue = m.group(1)
            if linked_issue:
                client.update_issue(int(linked_issue),
                                    {"labels": "ai-blocked"})
                client.add_note(int(linked_issue),
                                f"⚠️ MR 合并冲突（分支与目标存在冲突），请 rebase 后重试或将 label 改回 ai-todo")
            client._audit("merge-mr", f"MR#{mr_iid}", "conflict")
            raise SystemExit(1)

        if attempt < 3:
            print(f"[ci-bridge] MR !{mr_iid} not ready (HTTP {code}), retry {attempt}/3 in 30s...")
            time.sleep(30)
            mr = client.get_mr(mr_iid)  # refresh MR state
        else:
            print(f"[ci-bridge] Error: MR !{mr_iid} merge failed after 3 retries (HTTP {code})", file=sys.stderr)
            desc = mr.get("description", "")
            import re
            m = re.search(r'Closes #(\d+)', desc)
            if m:
                client.update_issue(int(m.group(1)), {"labels": "ai-blocked"})
                client.add_note(int(m.group(1)), f"⚠️ MR 合并失败（重试 3 次仍不可合并），请检查 MR 状态")
            client._audit("merge-mr", f"MR#{mr_iid}", "failed")
            raise SystemExit(1)


def cmd_close_mr(client: GitlabClient, args: argparse.Namespace):
    mr_iid = args.mr_iid
    mr_state = client.get_mr(mr_iid).get("state", "unknown")
    if mr_state != "opened":
        print(f"[ci-bridge] MR !{mr_iid} is {mr_state}, skipping close")
        client._audit("close-mr", f"MR#{mr_iid}", f"skipped_{mr_state}")
        return

    code, _ = client.close_mr(mr_iid)
    if 200 <= code < 300:
        print(f"[ci-bridge] Closed MR !{mr_iid}")
        client._audit("close-mr", f"MR#{mr_iid}", "success")
    else:
        print(f"[ci-bridge] Error closing MR !{mr_iid}: HTTP {code}", file=sys.stderr)
        raise SystemExit(1)


def cmd_create_mr(client: GitlabClient, args: argparse.Namespace):
    source = args.source
    target = args.target
    title = args.title
    labels = args.labels or "ci-ai"
    issue_iid = args.issue_iid

    # Check for existing MR on same source branch
    existing = client.list_mrs({"state": "opened", "source_branch": source, "per_page": "1"})
    if existing:
        iid = existing[0]["iid"]
        print(f"[ci-bridge] Reusing existing MR !{iid}")
        print(iid)
        client._audit("create-mr", f"MR#{iid}", "reused")
        return

    # Rate limit check
    max_mrs = int(os.environ.get("CI_AI_MAX_MRS", "0"))
    open_mrs = client.list_mrs({"state": "opened", "labels": "ci-ai", "per_page": "1"})
    open_count = len(open_mrs)
    if max_mrs > 0 and open_count >= max_mrs:
        print(f"[ci-bridge] Rate limit: {open_count}/{max_mrs} open AI MRs")
        client._audit("create-mr", "LIMIT", "rate_limited")
        raise SystemExit(1)

    print(f"[ci-bridge] {open_count}/{max_mrs} open AI MRs, proceeding")

    description = f"Closes #{issue_iid}" if issue_iid else ""
    full_title = f"[CI-AI] {title}"

    payload = {
        "title": full_title,
        "source_branch": source,
        "target_branch": target,
        "labels": labels,
        "remove_source_branch": True,
        "description": description,
    }

    code, resp = client.create_mr(payload)
    if 200 <= code < 300:
        iid = resp.get("iid")
        web_url = resp.get("web_url", "")
        print(f"[ci-bridge] Created MR !{iid}: {web_url}")
        print(iid)
        client._audit("create-mr", f"MR#{iid}", "success")
    else:
        print(f"[ci-bridge] Error: {resp}", file=sys.stderr)
        client._audit("create-mr", "MR", "failed")
        raise SystemExit(1)


def _trigger_pipeline(client: GitlabClient, issue_iid: str, label: str, extra_vars: str = ""):
    """触发下一阶段 pipeline。"""
    role = LABEL_TRIGGERS.get(label, "")
    if not role:
        return True

    default_branch = os.environ.get("CI_DEFAULT_BRANCH", "dev")
    variables = [
        {"key": "ISSUE_IID", "value": issue_iid},
        {"key": "TRIGGER_ROLE", "value": role},
        {"key": "TRIGGER_LABEL", "value": label},
    ]
    if extra_vars:
        for kv in extra_vars.split(","):
            if "=" in kv:
                k, v = kv.split("=", 1)
                variables.append({"key": k, "value": v})

    code, resp = client.trigger_pipeline(default_branch, variables)
    if 200 <= code < 300:
        web_url = resp.get("web_url", "unknown") if isinstance(resp, dict) else "unknown"
        print(f"[ci-bridge] Triggered pipeline (HTTP {code}): label={label} → role={role} | {web_url}")
        client._audit("trigger-pipeline", f"label={label}", web_url)
        return True
    else:
        err = str(resp)[:200]
        print(f"[ci-bridge] ERROR: Pipeline trigger failed (HTTP {code}): label={label} → role={role}", file=sys.stderr)
        print(f"[ci-bridge] Response: {err}", file=sys.stderr)
        client._audit("trigger-pipeline", f"label={label}", f"FAILED_HTTP_{code}")
        return False


def cmd_update_issue_label(client: GitlabClient, args: argparse.Namespace):
    iid = args.issue_iid
    add_labels = args.add or ""
    remove_labels = args.remove or ""
    trigger_next = args.trigger_next
    extra_vars = args.extra_vars or ""

    # Get current labels
    current = client.get_issue_labels(iid)

    # Remove labels
    remove_set = {r.strip() for r in remove_labels.split(",") if r.strip()}
    keep = [l for l in current if l not in remove_set]

    # Add labels
    add_set = {a.strip() for a in add_labels.split(",") if a.strip()}
    for a in add_set:
        if a not in keep:
            keep.append(a)

    new_labels = ",".join(keep)
    client.update_issue(iid, {"labels": new_labels})
    print(f"[ci-bridge] Updated Issue !{iid} (add: {add_labels or 'none'}, remove: {remove_labels or 'none'})")

    # Trigger next pipeline if requested
    if trigger_next and add_labels:
        trigger_failed = False
        for lbl in add_set:
            if not _trigger_pipeline(client, str(iid), lbl, extra_vars):
                trigger_failed = True
        if trigger_failed:
            print("[ci-bridge] WARNING: Pipeline trigger failed, but label is already updated. "
                  "Manual trigger may be needed.", file=sys.stderr)
            raise SystemExit(1)

    client._audit("update-issue-label", f"Issue#{iid}", "success")


def cmd_add_note(client: GitlabClient, args: argparse.Namespace):
    iid = args.issue_iid
    message = args.message or ""

    # Read from file if specified
    if args.file and os.path.isfile(args.file):
        with open(args.file) as f:
            message = f.read()

    if not message:
        print("[ci-bridge] Usage: ci-bridge.py add-note <issue_iid> --message=<msg> | --file=<path>", file=sys.stderr)
        raise SystemExit(1)

    client.add_note(iid, message)
    print(f"[ci-bridge] Added note to Issue !{iid}")
    client._audit("add-note", f"Issue#{iid}", "success")


def build_metadata(event: str, stage: str, metadata: dict | None = None) -> dict:
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    result = {
        "version": 1,
        "event": event,
        "stage": stage,
        "timestamp": ts,
    }
    pipeline_id = os.environ.get("CI_PIPELINE_ID", "")
    job_id = os.environ.get("CI_JOB_ID", "")
    if pipeline_id:
        result["pipeline_id"] = int(pipeline_id)
    if job_id:
        result["job_id"] = int(job_id)
    if metadata:
        result["metadata"] = metadata
    return result


def cmd_add_structured_note(client: GitlabClient, args: argparse.Namespace):
    iid = args.issue_iid
    message = args.message or ""
    event = args.event
    stage = args.stage
    metadata_raw = args.metadata or "{}"

    try:
        metadata = json.loads(metadata_raw)
    except json.JSONDecodeError as e:
        print(f"[ci-bridge] Error: --metadata is not valid JSON: {e}", file=sys.stderr)
        raise SystemExit(1)

    rd_meta = build_metadata(event, stage, metadata)

    client.add_note(iid, message, rd_metadata=rd_meta)
    print(f"[ci-bridge] Added structured note to Issue !{iid} (event={event}, stage={stage})")
    client._audit("add-structured-note", f"Issue#{iid}", f"event={event}")


def cmd_close_issue(client: GitlabClient, args: argparse.Namespace):
    iid = args.issue_iid
    comment = args.comment or ""

    state = client.get_issue(iid).get("state", "unknown")
    if state == "closed":
        print(f"[ci-bridge] Issue !{iid} already closed")
        client._audit("close-issue", f"Issue#{iid}", "already_closed")
        return

    client.close_issue(iid)
    if comment:
        client.add_note(iid, comment)

    print(f"[ci-bridge] Closed Issue !{iid}")
    client._audit("close-issue", f"Issue#{iid}", "success")


def cmd_list_issue_mrs(client: GitlabClient, args: argparse.Namespace):
    iid = args.issue_iid
    state = args.state or "all"

    params = {"per_page": "100"}
    if state != "all":
        params["state"] = state

    mrs = client.list_mrs(params)
    # Filter MRs related to the issue (by description Closes #iid)
    for m in mrs:
        desc = m.get("description", "")
        if f"#{iid}" in desc or f"Closes #{iid}" in desc:
            print(f"{m['iid']} {m.get('state','')} {m.get('source_branch','')} {m.get('title','')}")
    # Also try the related MRs endpoint
    code, data = client._request("GET", f"/issues/{iid}/related_merge_requests?per_page=100")
    if 200 <= code < 300 and isinstance(data, list):
        for m in data:
            print(f"{m.get('iid','')} {m.get('state','')} {m.get('source_branch','')} {m.get('title','')}")


def cmd_transition_spec(client: GitlabClient | None, args: argparse.Namespace):
    path = args.spec_meta_path
    new_status = args.new_status

    if not os.path.isfile(path):
        print(f"[ci-bridge] Error: {path} not found", file=sys.stderr)
        raise SystemExit(1)

    with open(path) as f:
        content = f.read()

    import re
    old_status = "unknown"
    m = re.search(r'^status:\s*(.*)', content, re.MULTILINE)
    if m:
        old_status = m.group(1).strip()
        content = re.sub(r'^status:.*', f'status: {new_status}', content, flags=re.MULTILINE)

    with open(path, "w") as f:
        f.write(content)

    subprocess.run(["git", "add", path], check=True)
    subprocess.run(["git", "commit", "-m",
                    f"ci-bridge: SPEC status {old_status} → {new_status}"], check=True)

    print(f"[ci-bridge] SPEC status: {old_status} → {new_status}")
    if client:
        client._audit("transition-spec", path, f"{old_status}->{new_status}")


# ─── CLI 入口 ───

def main():
    setup_logging()

    parser = argparse.ArgumentParser(
        description="ci-bridge — Agent 产出物流转桥接（GitLab API 封装）",
        prog="ci-bridge.py",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    # merge-mr
    p = sub.add_parser("merge-mr", help="合并 MR")
    p.add_argument("mr_iid", type=int)

    # close-mr
    p = sub.add_parser("close-mr", help="关闭 MR")
    p.add_argument("mr_iid", type=int)

    # create-mr
    p = sub.add_parser("create-mr", help="创建 MR")
    p.add_argument("--source", required=True)
    p.add_argument("--target", required=True)
    p.add_argument("--title", required=True)
    p.add_argument("--labels", default=None)
    p.add_argument("--issue-iid", default=None)

    # list-issue-mrs
    p = sub.add_parser("list-issue-mrs", help="列出 Issue 关联的 MR")
    p.add_argument("issue_iid", type=int)
    p.add_argument("--state", default="all")

    # update-issue-label
    p = sub.add_parser("update-issue-label", help="更新 Issue 标签")
    p.add_argument("issue_iid", type=int)
    p.add_argument("--add", default=None)
    p.add_argument("--remove", default=None)
    p.add_argument("--trigger-next", action="store_true", default=False)
    p.add_argument("--extra-vars", default=None)

    # add-note
    p = sub.add_parser("add-note", help="添加 Issue 评论")
    p.add_argument("issue_iid", type=int)
    p.add_argument("--message", default=None)
    p.add_argument("--file", default=None)

    # add-structured-note
    p = sub.add_parser("add-structured-note", help="添加结构化 Issue 评论")
    p.add_argument("issue_iid", type=int)
    p.add_argument("--message", required=True)
    p.add_argument("--event", required=True)
    p.add_argument("--stage", required=True)
    p.add_argument("--metadata", default="{}")

    # close-issue
    p = sub.add_parser("close-issue", help="关闭 Issue")
    p.add_argument("issue_iid", type=int)
    p.add_argument("--comment", default="")

    # transition-spec
    p = sub.add_parser("transition-spec", help="变更 SPEC 状态")
    p.add_argument("spec_meta_path")
    p.add_argument("new_status")

    args = parser.parse_args()

    # transition-spec doesn't need GitLab
    if args.command == "transition-spec":
        cmd_transition_spec(None, args)
        return

    client = GitlabClient()

    match args.command:
        case "merge-mr":
            cmd_merge_mr(client, args)
        case "close-mr":
            cmd_close_mr(client, args)
        case "create-mr":
            cmd_create_mr(client, args)
        case "list-issue-mrs":
            cmd_list_issue_mrs(client, args)
        case "update-issue-label":
            cmd_update_issue_label(client, args)
        case "add-note":
            cmd_add_note(client, args)
        case "add-structured-note":
            cmd_add_structured_note(client, args)
        case "close-issue":
            cmd_close_issue(client, args)
        case "transition-spec":
            cmd_transition_spec(client, args)
        case _:
            parser.print_help()
            raise SystemExit(1)


if __name__ == "__main__":
    main()
