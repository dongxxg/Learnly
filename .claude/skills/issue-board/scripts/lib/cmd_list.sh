# cmd_list.sh — list 命令实现
#
# list 永远是 project scope（向后兼容：默认查当前仓库）。改用 http_get_all
# + endpoint_issues 替代原 api_get，同时把 per_page 从 50 提升到 100 并自动
# 翻页（修复 >50 项被截断的 bug）。所有过滤 flag 与表格输出格式不变。

cmd_list() {
  # list always operates on the current project scope.
  scope_resolve project

  # Build query fragments (endpoint_query joins them with ?/& safely).
  local -a q=( "state=opened" "per_page=100" "order_by=created_at" "sort=desc" )

  # Default: only ai-detected issues; --all removes that filter.
  if [ "${ALL_ISSUES}" != true ]; then
    q+=( "labels[]=ai-detected" )
  fi

  if [ -n "${SEVERITY}" ]; then
    case "${SEVERITY}" in
      P0|P1|P2) q+=( "labels[]=${SEVERITY}" ) ;;
      *)
        echo "[gitlab-issue] Error: --severity must be P0, P1, or P2" >&2
        exit 1 ;;
    esac
  fi

  if [ -n "${DIMENSION}" ]; then
    local dim_label
    case "${DIMENSION}" in
      architecture) dim_label="ai-dimension:architecture" ;;
      code)         dim_label="ai-dimension:code" ;;
      test)         dim_label="ai-dimension:test" ;;
      security)     dim_label="ai-dimension:security" ;;
      docs)         dim_label="ai-dimension:docs" ;;
      *)
        echo "[gitlab-issue] Error: unknown dimension: ${DIMENSION}" >&2
        exit 1 ;;
    esac
    q+=( "labels[]=${dim_label}" )
  fi

  # 自定义标签过滤（逗号分隔，AND 逻辑）
  if [ -n "${LABELS_FILTER}" ]; then
    local _ifs_old="${IFS-}"
    IFS=','
    local -a _lbls=( ${LABELS_FILTER} )
    IFS="${_ifs_old}"
    local lbl
    for lbl in "${_lbls[@]}"; do
      lbl=$(echo "$lbl" | xargs)
      [ -n "$lbl" ] && q+=( "labels[]=${lbl}" )
    done
  fi

  if [ -n "${ASSIGNEE}" ]; then
    q+=( "assignee_username=${ASSIGNEE}" )
  fi

  if [ -n "${AUTHOR_FILTER}" ]; then
    q+=( "author_username=${AUTHOR_FILTER}" )
  fi

  local query endpoint response
  query=$(endpoint_query "${q[@]}")
  endpoint="$(endpoint_issues)${query}"
  response=$(http_get_all "${endpoint}")

  if [ "${FORMAT}" = "json" ]; then
    printf '%s' "${response}" | json_pretty
    return
  fi

  local count
  count=$(printf '%s' "${response}" | json_len)
  if [ "${count}" -eq 0 ]; then
    if [ "${ALL_ISSUES}" = true ]; then
      echo "No open issues found."
    else
      echo "No open AI-detected issues. (use --all to see all issues)"
    fi
    return
  fi

  # 按 P0/P1/P2 分组输出 Markdown 表格
  local p0 p1 p2 others
  p0=$(printf '%s' "${response}" | json_count '"P0" in (x.get("labels") or [])')
  p1=$(printf '%s' "${response}" | json_count '"P1" in (x.get("labels") or [])')
  p2=$(printf '%s' "${response}" | json_count '"P2" in (x.get("labels") or [])')
  others=$(( count - p0 - p1 - p2 ))

  local board_title
  board_title="AI Issue Board"
  [ "${ALL_ISSUES}" = true ] && board_title="Issue Board（全部）"
  echo "## ${board_title} (${count} open)"
  echo ""

  # 通用表格输出函数。filter_label ∈ {P0, P1, P2, others}.
  print_table() {
    local filter_label="$1"
    echo "| IID | 维度 | 作者 | 指派 | 创建日期 | 评论 | MR | 标题 |"
    echo "|-----|------|------|------|---------|------|-----|------|"
    printf '%s' "${response}" | FILTER="${filter_label}" python3 -c '
import sys, json, os
filter_label = os.environ["FILTER"]
data = json.load(sys.stdin)

def has_label(issue, label):
    return label in (issue.get("labels") or [])

def matches(issue):
    if filter_label == "others":
        return not (has_label(issue, "P0") or has_label(issue, "P1") or has_label(issue, "P2"))
    return has_label(issue, filter_label)

def derive_dim(issue):
    labels = issue.get("labels") or []
    for lab in labels:
        if lab.startswith("ai-dimension:"):
            return lab[len("ai-dimension:"):]
    for lab in labels:
        if not (lab.startswith("ai-") or lab in ("P0", "P1", "P2")):
            return lab
    return "?"

for issue in data:
    if not matches(issue):
        continue
    iid = issue.get("iid", "")
    dim = derive_dim(issue)
    author = (issue.get("author") or {}).get("username") or "?"
    assignee = (issue.get("assignee") or {}).get("username") or "未指派"
    created = (issue.get("created_at") or "")[:10]
    notes = issue.get("user_notes_count") or 0
    mrs = issue.get("merge_requests_count") or 0
    title = issue.get("title") or ""
    print(f"{iid}\t{dim}\t{author}\t{assignee}\t{created}\t{notes}\t{mrs}\t{title}")
' | while IFS=$'\t' read -r iid dim author assignee created notes mrs title; do
      printf "| !%s | %s | %s | %s | %s | %s | %s | %s |\n" "${iid}" "${dim}" "${author}" "${assignee}" "${created}" "${notes}" "${mrs}" "${title}"
    done
  }

  # P0
  echo "### 🚫 P0（阻断）— ${p0} 项"
  [ "${p0}" -gt 0 ] && print_table 'P0'
  echo ""

  # P1
  echo "### ⚠️ P1（重要）— ${p1} 项"
  [ "${p1}" -gt 0 ] && print_table 'P1'
  echo ""

  # P2
  echo "### 💡 P2（建议）— ${p2} 项"
  [ "${p2}" -gt 0 ] && print_table 'P2'
  echo ""

  # 未分级
  if [ "${others}" -gt 0 ]; then
    echo "### ❓ 未分级 — ${others} 项"
    print_table 'others'
    echo ""
  fi

  echo "> 使用 \`--severity P0/P1/P2\` 或 \`--labels 'label1,label2'\` 或 \`--all\` 过滤"
}
