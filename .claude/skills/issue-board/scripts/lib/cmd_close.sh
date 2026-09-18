# cmd_close.sh — close 命令实现
#
# 改造点（plan 第 6.4 节）：
#   - 旁路 curl 发 notes 评论收敛进 http_post(endpoint_issue_notes)
#   - notes 评论失败只 warn 不 exit（保留原 2>/dev/null 静默的容错语义，
#     不阻断 close 主流程；但通过 http 层至少在 stderr 留下可读错误）
#   - api_put → http_put

cmd_close() {
  if [ -z "${IID}" ]; then
    echo "[gitlab-issue] Error: specify issue IID" >&2
    exit 1
  fi

  scope_resolve project

  local data='{"state_event": "close"}'

  if [ -n "${MR_REF:-}" ]; then
    local note_body="Closed. Related MR: ${MR_REF}"
    local note_data
    note_data=$(NOTE_BODY="${note_body}" python3 -c '
import os, json
print(json.dumps({"body": os.environ["NOTE_BODY"]}, ensure_ascii=False))
')
    # Post the note. Failure here is a warning only — close must still proceed.
    if ! http_post "$(endpoint_issue_notes "${IID}")" "${note_data}" >/dev/null; then
      echo "[gitlab-issue] Warn: failed to post close note (issue ${IID} will still be closed)" >&2
    fi
  fi

  local response
  response=$(http_put "$(endpoint_issue "${IID}")" "${data}")

  if printf '%s' "${response}" | json_py '
import sys, json
d = json.load(sys.stdin)
sys.exit(0 if d.get("iid") is not None else 1)
' 2>/dev/null; then
    echo "[gitlab-issue] Closed Issue $(_issue_ref "${IID}")"
  else
    echo "[gitlab-issue] Error: close failed" >&2
    exit 1
  fi
}
