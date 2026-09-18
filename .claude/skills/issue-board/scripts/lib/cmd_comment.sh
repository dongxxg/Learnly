# cmd_comment.sh — comment 命令实现

cmd_comment() {
  if [ -z "${IID}" ]; then
    echo "[gitlab-issue] Error: specify issue IID" >&2
    exit 1
  fi
  if [ -z "${COMMENT_BODY}" ]; then
    echo "[gitlab-issue] Error: --body is required" >&2
    exit 1
  fi

  scope_resolve project

  local note_data
  note_data=$(NOTE_BODY="${COMMENT_BODY}" python3 -c '
import os, json
print(json.dumps({"body": os.environ["NOTE_BODY"]}, ensure_ascii=False))
')

  local response
  response=$(http_post "$(endpoint_issue_notes "${IID}")" "${note_data}")

  if printf '%s' "${response}" | json_py '
import sys, json
d = json.load(sys.stdin)
sys.exit(0 if d.get("id") is not None else 1)
' 2>/dev/null; then
    echo "[gitlab-issue] Comment added to Issue $(_issue_ref "${IID}")"
  else
    echo "[gitlab-issue] Error: comment failed" >&2
    exit 1
  fi
}
