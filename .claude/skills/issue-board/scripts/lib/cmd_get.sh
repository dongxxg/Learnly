# cmd_get.sh — get 命令实现

cmd_get() {
  if [ -z "${IID}" ]; then
    echo "[gitlab-issue] Error: specify issue IID" >&2
    exit 1
  fi

  scope_resolve project

  local response
  response=$(http_get "$(endpoint_issue "${IID}")")

  if [ "${FORMAT}" = "json" ]; then
    printf '%s' "${response}" | json_pretty
    return
  fi

  local state title pri dim labels_str author assignee created_at due_date updated_at notes mrs web_url description
  state=$(printf '%s' "${response}" | json_get 'state')
  title=$(printf '%s' "${response}" | json_get 'title')
  author=$(printf '%s' "${response}" | json_get 'author.username' '?')
  assignee=$(printf '%s' "${response}" | json_get 'assignee.username' '未指派')
  created_at=$(printf '%s' "${response}" | json_get 'created_at')
  due_date=$(printf '%s' "${response}" | json_get 'due_date' '未设置')
  updated_at=$(printf '%s' "${response}" | json_get 'updated_at')
  notes=$(printf '%s' "${response}" | json_get 'user_notes_count' 0)
  mrs=$(printf '%s' "${response}" | json_get 'merge_requests_count' 0)
  web_url=$(printf '%s' "${response}" | json_get 'web_url')
  description=$(printf '%s' "${response}" | json_get 'description' '无描述')

  # labels-derived fields: P0|P1|P2 priority, ai-dimension: tag, comma-joined labels.
  labels_str=$(printf '%s' "${response}" | json_py '
import sys, json
d = json.load(sys.stdin)
labels = d.get("labels") or []
print(", ".join(labels))
')
  pri=$(printf '%s' "${response}" | json_py '
import sys, json, re
d = json.load(sys.stdin)
labels = d.get("labels") or []
for lab in labels:
    if re.match(r"^(P0|P1|P2)$", lab):
        print(lab); break
else:
    print("?")
')
  dim=$(printf '%s' "${response}" | json_py '
import sys, json
def main():
    d = json.load(sys.stdin)
    labels = d.get("labels") or []
    for lab in labels:
        if lab.startswith("ai-dimension:"):
            print(lab[len("ai-dimension:"):]); return
    for lab in labels:
        if not (lab.startswith("ai-") or lab in ("P0", "P1", "P2")):
            print(lab[len("ai-dimension:"):] if lab.startswith("ai-dimension:") else lab); return
    print("?")
main()
' 2>/dev/null || echo "?")

  local state_icon
  case "${state}" in
    opened) state_icon="🟢 opened" ;;
    closed) state_icon="🔒 closed" ;;
    *)      state_icon="${state}" ;;
  esac

  echo "## Issue $(_issue_ref "${IID}")"
  echo ""
  echo "| 字段 | 值 |"
  echo "|------|-----|"
  echo "| 标题 | ${title} |"
  echo "| 状态 | ${state_icon} |"
  echo "| 优先级 | ${pri} |"
  echo "| 维度 | ${dim} |"
  echo "| 标签 | ${labels_str} |"
  echo "| 作者 | ${author} |"
  echo "| 指派 | ${assignee} |"
  echo "| 创建 | ${created_at} |"
  echo "| 到期 | ${due_date} |"
  echo "| 更新 | ${updated_at} |"
  echo "| 评论 | ${notes} |"
  echo "| 关联MR | ${mrs} |"
  echo "| 链接 | ${web_url} |"
  echo ""
  echo "### 描述"
  echo ""
  printf '%s\n' "${description}"
}
