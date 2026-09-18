# cmd_update.sh — update 命令实现
#
# 改造点（plan 第 6.3 节）：
#   - 旁路 curl 查询 user 收敛进 http_get(endpoint_users)?username=...
#   - api_put → http_put(endpoint_issue)

cmd_update() {
  if [ -z "${IID}" ]; then
    echo "[gitlab-issue] Error: specify issue IID" >&2
    exit 1
  fi

  scope_resolve project

  local data="{}"

  if [ -n "${ASSIGNEE}" ]; then
    local user_resp user_id
    user_resp=$(http_get "$(endpoint_users)?username=${ASSIGNEE}")
    user_id=$(printf '%s' "${user_resp}" | json_py '
import sys, json
d = json.load(sys.stdin)
if isinstance(d, list) and d:
    v = d[0].get("id")
    if v is not None:
        print(v)
')
    if [ -z "${user_id}" ]; then
      echo "[gitlab-issue] Error: user '${ASSIGNEE}' not found" >&2
      exit 1
    fi
    data=$(USER_ID="${user_id}" python3 -c '
import json, os
d = json.loads(os.environ["DATA_IN"]) if os.environ.get("DATA_IN") else {}
d["assignee_ids"] = [int(os.environ["USER_ID"])]
print(json.dumps(d, ensure_ascii=False))
' DATA_IN="${data}")
  fi

  if [ -n "${LABELS_FILTER}" ]; then
    data=$(LABELS="${LABELS_FILTER}" DATA_IN="${data}" python3 -c '
import json, os
d = json.loads(os.environ["DATA_IN"]) if os.environ.get("DATA_IN") else {}
labels = [s.strip() for s in os.environ["LABELS"].split(",") if s.strip()]
d["labels"] = labels
print(json.dumps(d, ensure_ascii=False))
')
  fi

  if [ -n "${DUE_DATE}" ]; then
    data=$(DUE_DATE="${DUE_DATE}" DATA_IN="${data}" python3 -c '
import json, os
d = json.loads(os.environ["DATA_IN"]) if os.environ.get("DATA_IN") else {}
d["due_date"] = os.environ["DUE_DATE"]
print(json.dumps(d, ensure_ascii=False))
')
  fi

  local response
  response=$(http_put "$(endpoint_issue "${IID}")" "${data}")

  if printf '%s' "${response}" | json_py '
import sys, json
d = json.load(sys.stdin)
sys.exit(0 if d.get("iid") is not None else 1)
' 2>/dev/null; then
    echo "[gitlab-issue] Updated Issue $(_issue_ref "${IID}")"
  else
    echo "[gitlab-issue] Error: update failed" >&2
    exit 1
  fi
}
