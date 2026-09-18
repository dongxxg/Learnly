# cmd_milestone.sh — milestone 命令实现
#
# 查询 group-level milestone 跨项目 issues。流程（plan 第 7.2 节）：
#   1. 校验 GROUP_PATH / MILESTONE_IID（parse_args 已做）
#   2. scope_resolve group → 推导 GROUP_ID（首次，缓存）
#   3. GET /groups/<id>/milestones → 找 iid 匹配项，拿真实 id/title/due_date/...
#   4. http_get_all /groups/<id>/milestones/<mid>/issues?state=...&per_page=100
#   5. python3 规范化输出（schema 见 plan 7.3）
#
# JSON schema（规范化，非原样透传）保证跨 project iid 重复时可唯一定位。
# 注：本文件原用 jq，已迁到 python3（lib/json.sh + 内联 python）。

cmd_milestone() {
  # parse_args guarantees GROUP_PATH and MILESTONE_IID are non-empty.
  scope_resolve group "${GROUP_PATH}"

  # Resolve milestone iid → API id. We fetch ALL milestones here (no state
  # filter) because GitLab's milestones endpoint uses state=active|closed
  # (NOT "opened"), and this step is only about iid→id lookup — the user's
  # --state flag filters the ISSUES under the milestone, not which milestone
  # we resolve. This avoids the state value mismatch and lets users query a
  # closed milestone's issues too.
  local ms_list_endpoint ms_query
  ms_query=$(endpoint_query "per_page=100")
  ms_list_endpoint="$(endpoint_milestones)${ms_query}"
  local ms_list_resp
  ms_list_resp=$(http_get_all "${ms_list_endpoint}")

  # Find the milestone whose .iid matches MILESTONE_IID.
  local ms_obj
  ms_obj=$(printf '%s' "${ms_list_resp}" | MILESTONE_IID="${MILESTONE_IID}" python3 -c '
import sys, json, os
target_iid = os.environ["MILESTONE_IID"]
try:
    target = int(target_iid)
except ValueError:
    target = None
data = json.load(sys.stdin)
if not isinstance(data, list):
    sys.exit(0)
for m in data:
    if m.get("iid") == target:
        print(json.dumps(m, ensure_ascii=False))
        break
')

  if [ -z "${ms_obj}" ]; then
    local avail
    avail=$(printf '%s' "${ms_list_resp}" | python3 -c '
import sys, json
try:
    data = json.load(sys.stdin)
    if isinstance(data, list):
        print(", ".join(str(m.get("iid", "?")) for m in data))
    else:
        print("?")
except Exception:
    print("?")
' 2>/dev/null || echo "?")
    echo "[gitlab-issue] Error: milestone iid=${MILESTONE_IID} not found in group ${GROUP_PATH}" >&2
    echo "  available iids: ${avail}" >&2
    exit 1
  fi

  local ms_id ms_normalized
  ms_id=$(printf '%s' "${ms_obj}" | json_get 'id')
  ms_normalized=$(printf '%s' "${ms_obj}" | python3 -c '
import sys, json
m = json.load(sys.stdin)
out = {
    "id": m.get("id"),
    "iid": m.get("iid"),
    "title": m.get("title"),
    "description": m.get("description"),
    "state": m.get("state"),
    "due_date": m.get("due_date"),
    "start_date": m.get("start_date"),
    "group": {
        "id": m.get("group_id"),
        "full_path": (m.get("group") or {}).get("path", ""),
    },
}
print(json.dumps(out, ensure_ascii=False))
')

  # Fetch all issues under this milestone (auto-paginated).
  # NOTE: GitLab's milestone-issues endpoint ignores the state=filter on some
  # versions, so we fetch ALL issues here and filter client-side below. This
  # keeps --state opened|closed|all semantics correct and predictable.
  local issues_endpoint issues_query issues_resp
  issues_query=$(endpoint_query "per_page=100")
  issues_endpoint="$(endpoint_milestone_issues "${ms_id}")${issues_query}"
  issues_resp=$(http_get_all "${issues_endpoint}")

  # Client-side state filter (--state all → keep everything).
  if [ "${MILESTONE_STATE}" != "all" ]; then
    issues_resp=$(printf '%s' "${issues_resp}" | STATE="${MILESTONE_STATE}" python3 -c '
import sys, json, os
state = os.environ["STATE"]
data = json.load(sys.stdin)
if not isinstance(data, list):
    sys.exit(0)
filtered = [x for x in data if x.get("state") == state]
print(json.dumps(filtered, ensure_ascii=False))
')
  fi

  # Combine milestone metadata + raw issues into one JSON document, then hand
  # to the python builder on stdin (replaces jq slurpfile).
  local combined
  combined=$(MS_NORMALIZED="${ms_normalized}" ISSUES_RESP="${issues_resp}" python3 -c '
import json, os
out = {
    "milestone": json.loads(os.environ["MS_NORMALIZED"]),
    "issues": json.loads(os.environ["ISSUES_RESP"]),
}
print(json.dumps(out, ensure_ascii=False))
')

  local output
  output=$(printf '%s' "${combined}" | python3 -c '
import sys, json, re
from collections import defaultdict

doc = json.load(sys.stdin)
milestone = doc["milestone"]
issues = doc["issues"]

def proj_path(i):
    ref = (i.get("references") or {}).get("full")
    if ref:
        return re.sub(r"#.*$", "", ref)
    url = i.get("web_url", "")
    url = re.sub(r"^https?://[^/]+/", "", url)
    url = re.sub(r"/-/work_items/.*$", "", url)
    url = re.sub(r"/-/issues/.*$", "", url)
    return url

def full_ref(i):
    ref = (i.get("references") or {}).get("full")
    if ref:
        return ref
    return "{}#{}".format(proj_path(i), i.get("iid"))

opened = sum(1 for x in issues if x.get("state") == "opened")
closed = sum(1 for x in issues if x.get("state") == "closed")

# group_by(.project_id) → sort by count desc, then path asc
buckets = {}
for x in issues:
    pid = x.get("project_id") or 0
    if pid not in buckets:
        buckets[pid] = {"project_id": pid, "path": proj_path(x), "count": 0}
    buckets[pid]["count"] += 1
by_project = sorted(buckets.values(), key=lambda v: (-v["count"], v["path"]))

normalized = []
for x in issues:
    normalized.append({
        "iid": x.get("iid"),
        "project_id": x.get("project_id"),
        "project_path": proj_path(x),
        "full_ref": full_ref(x),
        "web_url": x.get("web_url"),
        "title": x.get("title"),
        "state": x.get("state"),
        "due_date": x.get("due_date"),
        "labels": x.get("labels") or [],
        "assignees": [{"username": a.get("username")} for a in (x.get("assignees") or [])],
        "author": {"username": (x.get("author") or {}).get("username")},
        "created_at": x.get("created_at"),
        "updated_at": x.get("updated_at"),
        "user_notes_count": x.get("user_notes_count") or 0,
        "merge_requests_count": x.get("merge_requests_count") or 0,
    })

print(json.dumps({
    "milestone": milestone,
    "summary": {
        "total": len(issues),
        "opened": opened,
        "closed": closed,
        "by_project": by_project,
    },
    "issues": normalized,
}, ensure_ascii=False, indent=2))
')

  if [ "${FORMAT}" = "json" ]; then
    printf '%s\n' "${output}"
    return
  fi

  # table mode: group by project, list iid/title/state/labels per group.
  printf '%s\n' "${output}" | python3 -c '
import sys, json
d = json.load(sys.stdin)
m = d["milestone"]
s = d["summary"]
print("# Milestone: {}  (state={}, due={})".format(m.get("title"), m.get("state") or "?", m.get("due_date") or "-"))
print("Total: {} (opened={}, closed={})".format(s["total"], s["opened"], s["closed"]))
print()
for proj in s["by_project"]:
    print("## {}  ({})".format(proj["path"], proj["count"]))
    print("| IID | Title | State | Labels |")
    print("|-----|-------|-------|--------|")
' 2>/dev/null || true

  printf '%s\n' "${output}" | python3 -c '
import sys, json
from itertools import groupby
d = json.load(sys.stdin)
issues = d["issues"]
issues_sorted = sorted(issues, key=lambda x: x.get("project_path") or "")
for project_path, group in groupby(issues_sorted, key=lambda x: x.get("project_path") or ""):
    for issue in group:
        labels = ", ".join(issue.get("labels") or [])
        print("| {} | {} | {} | {} |".format(issue.get("full_ref"), issue.get("title"), issue.get("state"), labels))
' 2>/dev/null || true
}
