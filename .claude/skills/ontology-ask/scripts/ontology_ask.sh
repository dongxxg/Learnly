#!/usr/bin/env bash
# ontology_ask.sh — 探索场景本体调用 CLI（ontology-ask skill 唯一脚本）
#
# 设计文档：.harness/knowledge/ontology-ask-skill-design.md
# 四子命令（统一 JSON 输出，success 判成败，失败 stderr 单行 JSON + exit 1）：
#   ontology_ask.sh discover [--all] [关键词...]   ① 注册表检索 / 全索引提名
#   ontology_ask.sh schema <file> [--refresh]      ② 拉领域模型 YAML（version 缓存）
#   ontology_ask.sh query <file> <fn> [json]       ③ domain-query 直调（30s 超时 + 1 次重试）
#   ontology_ask.sh chat <file> "问题"              ④ 兜底对话（会话 30min 复用）
# ②③④ 执行前过注册表门禁：未注册 NOT_REGISTERED / 版本漂移或草稿态 STALE → exit 1
#
# 依赖：bash / curl / python3(+PyYAML)
# 环境变量：ONTO_BASE / ONTO_TENANT / ONTO_USER / ONTO_REGISTRY / ONTO_DEFAULT_FILE
#           ONTO_INDEX_TIMEOUT(15s) / ONTO_CHAT_TIMEOUT(120s) / ONTO_SESSION_TTL_MIN(30)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE="${ONTO_BASE:-http://192.168.201.129:30002/agent-onto-harness}"
TENANT="${ONTO_TENANT:-DEP001}"
USER_HEADER="${ONTO_USER:-liubo@unitechs.com}"
REGISTRY="${ONTO_REGISTRY:-$SCRIPT_DIR/../registry.yaml}"
DEFAULT_FILE="${ONTO_DEFAULT_FILE:-network-resource-ops.yml}"
SESSION_TTL_MIN="${ONTO_SESSION_TTL_MIN:-30}"

die() { # die <code> <msg> → stderr 单行 JSON，exit 1
  echo "{\"success\":false,\"error\":\"$1\",\"message\":$(json_str "$2")}" >&2
  exit 1
}
json_str() { python3 -c 'import json,sys; print(json.dumps(sys.argv[1], ensure_ascii=False))' "$1"; }
out() { echo "$1"; }
cache_dir() { printf '%s/.cache/ontology-ask/%s' "$HOME" "$(printf '%s' "$BASE" | md5sum | cut -c1-8)"; }

# ---------- 公共：本体索引（live version / draft 判定的唯一来源） ----------
fetch_index() {
  curl -sS --connect-timeout 10 --max-time "${ONTO_INDEX_TIMEOUT:-15}" "$BASE/api/ontologies" \
    -H "x-sys-code: $TENANT" -H "currentnetuserid: $USER_HEADER" 2>/dev/null || true
}

# index_lookup <index_file> <file> → 本体元数据 JSON（无则空）
# 730 条索引超 ARG_MAX 且 python3 - 的 stdin 被 heredoc 脚本占用 → 数据走临时文件
index_lookup() {
  python3 - "$1" "$2" <<'PY'
import json, sys
try:
    idx = json.load(open(sys.argv[1]))
except Exception:
    sys.exit(0)
for o in (idx if isinstance(idx, list) else []):
    if o.get("file") == sys.argv[2]:
        print(json.dumps(o, ensure_ascii=False))
        break
PY
}

# fetch_index_file → 拉索引落临时文件，stdout 输出路径（空索引输出空串）
fetch_index_file() {
  local tmp
  tmp=$(mktemp /tmp/onto_idx.XXXXXX)
  if fetch_index > "$tmp" && [ -s "$tmp" ]; then
    printf '%s' "$tmp"
  else
    rm -f "$tmp"
    printf '%s' ""
  fi
}

# ---------- 注册表门禁 ----------
# gate <file>：校验注册表（active）+ 环境（存在 / draft:false / 版本一致）
# 成功输出 "<situation>|<live_version>"，失败 die NOT_REGISTERED / STALE
gate() {
  local file="$1" entry live_file meta situation reg_version live_version live_draft
  [ -f "$REGISTRY" ] || die NOT_REGISTERED "注册表不存在: $REGISTRY"
  entry=$(python3 - "$REGISTRY" "$file" <<'PY'
import sys, json, yaml
reg = yaml.safe_load(open(sys.argv[1])) or {}
for e in (reg.get("ontologies") or []):
    if e.get("file") == sys.argv[2]:
        print(json.dumps(e, ensure_ascii=False, default=str))
        break
PY
) || true
  [ -n "$entry" ] || die NOT_REGISTERED "本体未注册: $file（discover --all 可提名，走准入流程后登记，见设计 §5.4.1）"
  situation=$(printf '%s' "$entry" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("situation",""))')
  reg_version=$(printf '%s' "$entry" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("version",""))')
  [ "$(printf '%s' "$entry" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("state",""))')" = "active" ] \
    || die STALE "本体已 retired: $file"
  live_file=$(fetch_index_file)
  [ -n "$live_file" ] || die INDEX_UNAVAILABLE "本体索引不可达: $BASE/api/ontologies"
  meta=$(index_lookup "$live_file" "$file")
  rm -f "$live_file"
  [ -n "$meta" ] || die STALE "本体已从环境消失: $file（重新验证或登记 state: retired）"
  live_version=$(printf '%s' "$meta" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("version") or "")')
  live_draft=$(printf '%s' "$meta" | python3 -c 'import json,sys; print("true" if json.load(sys.stdin).get("draft") else "false")')
  [ "$live_draft" = "false" ] || die STALE "本体处于草稿态（draft:true），须发布后再用: $file"
  [ "$live_version" = "$reg_version" ] \
    || die STALE "版本漂移: 登记 $reg_version ≠ 环境 $live_version，请重新验证并更新 registry.yaml"
  printf '%s|%s' "$situation" "$live_version"
}

# ---------- ① discover ----------
cmd_discover() {
  local all=0
  if [ "${1:-}" = "--all" ]; then all=1; shift; fi
  [ -f "$REGISTRY" ] || die NOT_REGISTERED "注册表不存在: $REGISTRY"
  local idx_file
  idx_file=$(fetch_index_file)
  [ -n "$idx_file" ] || die INDEX_UNAVAILABLE "本体索引不可达: $BASE/api/ontologies"
  python3 - "$all" "$idx_file" "$REGISTRY" "$@" <<'PY'
import json, os, sys

try:
    import yaml
    reg = {e.get("file"): e for e in ((yaml.safe_load(open(sys.argv[3])) or {}).get("ontologies") or [])}
except Exception:
    reg = {}
all_flag = sys.argv[1] == "1"
idx = json.load(open(sys.argv[2]))
keywords = [k for k in sys.argv[4:] if k]

def match(o):
    if not keywords:
        return True
    hay = " ".join(str(o.get(k) or "") for k in ("file", "situation", "domain", "anchor", "description"))
    return any(k in hay for k in keywords)

items = []
for o in idx:
    if not match(o):
        continue
    e = reg.get(o.get("file"))
    if not all_flag:
        # 默认模式：仅注册表内条目，带 live/stale 检测
        if not e or e.get("state") != "active":
            continue
        items.append({"file": o.get("file"), "situation": e.get("situation"), "domain": e.get("domain"),
                      "registered_version": e.get("version"), "live_version": o.get("version"),
                      "state": "active" if e.get("version") == o.get("version") else "stale",
                      "verified_at": str(e.get("verified_at", "")), "keywords": e.get("keywords", [])})
    else:
        # 提名模式：全索引命中项，带规模元数据辅助判断可信度
        if e and e.get("state") == "active" and e.get("version") == o.get("version"):
            st = "active"
        elif e and e.get("state") == "active":
            st = "stale"
        elif e:
            st = "retired"
        else:
            st = "unregistered"
        items.append({"file": o.get("file"), "situation": o.get("situation"), "domain": o.get("domain"),
                      "anchor": o.get("anchor"), "version": o.get("version"),
                      "object_types": o.get("object_types"), "properties": o.get("properties"),
                      "links": o.get("links"), "draft": bool(o.get("draft")), "state": st})
# 排序：已注册可信本体优先，未注册按规模降序（垃圾小本体沉底，辅助可信度判断）
order = {"active": 0, "stale": 1, "retired": 2, "unregistered": 3}
items.sort(key=lambda x: (order.get(x.get("state"), 9), -(x.get("object_types") or 0)))
res = {"success": True, "count": len(items), "items": items}
if all_flag:
    res["hint"] = "unregistered 本体禁止 schema/query/chat，走准入流程（设计 §5.4.1）后登记"
print(json.dumps(res, ensure_ascii=False))
PY
  rm -f "$idx_file"
}

# ---------- ② schema ----------
cmd_schema() {
  local file="" refresh=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --refresh) refresh=1 ;;
      *) file="$1" ;;
    esac
    shift
  done
  [ -n "$file" ] || file="$DEFAULT_FILE"
  local gv situation live_version
  gv=$(gate "$file")
  situation="${gv%%|*}"; live_version="${gv##*|}"
  local host_hash cache_path
  host_hash="$(cache_dir)"
  cache_path="$host_hash/$file/v${live_version}.yml"
  if [ "$refresh" = "0" ] && [ -f "$cache_path" ]; then
    out "{\"success\":true,\"file\":$(json_str "$file"),\"version\":$(json_str "$live_version"),\"cache\":\"hit\",\"path\":$(json_str "$cache_path"),\"situation\":$(json_str "$situation")}"
    return 0
  fi
  local body http_code
  body=$(curl -sS --connect-timeout 10 --max-time 20 -w "\n%{http_code}" \
    "$BASE/api/ontologies/$file/yaml" \
    -H "x-sys-code: $TENANT" -H "currentnetuserid: $USER_HEADER") \
    || die SCHEMA_FETCH_FAILED "yaml 下载失败: $file"
  http_code="${body##*$'\n'}"
  [ "$http_code" = "200" ] || die SCHEMA_FETCH_FAILED "yaml 下载 HTTP $http_code: $file（端点认 file 字段非 situation 名）"
  mkdir -p "$(dirname "$cache_path")"
  printf '%s' "${body%$'\n'*}" | python3 -c 'import json,sys; sys.stdout.write(json.load(sys.stdin).get("content",""))' > "$cache_path" \
    || die SCHEMA_FETCH_FAILED "yaml 内容解析失败: $file"
  # 内容版本回验（尖刺 7 延伸：索引 version 可能滞后，防旧版本号缓存装进新内容且永不失效）
  content_version=$(python3 -c 'import sys,yaml; print((yaml.safe_load(open(sys.argv[1])) or {}).get("metadata",{}).get("version","") or "")' "$cache_path")
  if [ -n "$content_version" ] && [ "$content_version" != "$live_version" ]; then
    rm -f "$cache_path"
    die VERSION_MISMATCH "YAML 内容版本($content_version) ≠ 索引版本($live_version)：本体已更新而索引 version 滞后，请人工核对服务端版本后更新 registry.yaml"
  fi
  out "{\"success\":true,\"file\":$(json_str "$file"),\"version\":$(json_str "$live_version"),\"cache\":\"miss\",\"path\":$(json_str "$cache_path"),\"situation\":$(json_str "$situation")}"
}

# ---------- ③ query ----------
# registry_has_file <name> → 注册表中存在该 file 返回 0（query 形态判别用）
registry_has_file() {
  python3 - "$REGISTRY" "$1" <<'PY'
import sys, yaml
try:
    reg = yaml.safe_load(open(sys.argv[1])) or {}
except Exception:
    sys.exit(1)
for e in (reg.get("ontologies") or []):
    if e.get("file") == sys.argv[2]:
        sys.exit(0)
sys.exit(1)
PY
}

cmd_query() {
  local file="${1:-}" fn="${2:-}" params="${3:-{\}}"
  # 形态判别（按注册表，非猜测）：
  #   query <fn> [params]        → $1 非注册文件名 → 默认本体
  #   query <file> <fn> [params] → $1 是注册文件名 → 显式本体
  if [ -n "$file" ] && [ -z "$fn" ]; then
    fn="$file"; file="$DEFAULT_FILE"
  elif [ -n "$fn" ] && ! registry_has_file "$file"; then
    params="$fn"; fn="$file"; file="$DEFAULT_FILE"
  fi
  [ -n "$file" ] || file="$DEFAULT_FILE"
  [ -n "$fn" ] || die USAGE "用法: ontology_ask.sh query <file> <functionName> [json-params] ｜ 或 query <functionName> [json-params]（默认本体）"
  python3 -c 'import json,sys; json.loads(sys.argv[1])' "$params" >/dev/null 2>&1 \
    || die BAD_PARAMS "params 不是合法 JSON: $params"
  local gv situation
  gv=$(gate "$file")
  situation="${gv%%|*}"
  local payload body http_code result_json
  payload=$(python3 -c 'import json,sys; print(json.dumps({"ontologyId":sys.argv[1],"queryName":sys.argv[2],"parameters":json.loads(sys.argv[3])}, ensure_ascii=False))' "$situation" "$fn" "$params")
  body=""
  for attempt in 1 2; do
    if body=$(curl -sS --connect-timeout 10 --max-time 30 -w "\n%{http_code}" \
      -X POST "$BASE/api/ontology/domain-query" \
      -H "x-sys-code: $TENANT" -H "currentnetuserid: $USER_HEADER" -H "Content-Type: application/json" \
      -d "$payload"); then
      break
    fi
    if [ "$attempt" = "2" ]; then
      die QUERY_FAILED "domain-query 两次尝试均失败: $fn（已含冷启动重试）"
    fi
  done
  http_code="${body##*$'\n'}"
  if [ "$http_code" = "404" ]; then
    # 404 细分：函数不存在 vs relation 函数不可直调（查本地 schema 缓存给出可行动报错）
    local gv2 lv cache_yaml fn_info
    gv2=$(gate "$file"); lv="${gv2##*|}"
    cache_yaml="$(cache_dir)/$file/v${lv}.yml"
    if [ -f "$cache_yaml" ]; then
      fn_info=$(python3 - "$cache_yaml" "$fn" <<'PY'
import sys, yaml
spec = yaml.safe_load(open(sys.argv[1])) or {}
fns = {f.get("name"): f.get("type") for f in (spec.get("functions") or [])}
name, t = sys.argv[2], fns.get(sys.argv[2])
if t is None:
    print("missing|" + ",".join(sorted(fns)))
elif t == "relation":
    print("relation|")
else:
    print("query|")
PY
) || fn_info=""
      case "${fn_info%%|*}" in
        relation) die QUERY_FAILED "$fn 是 relation 类型函数（由 link 引擎注入 facts 调用），不能 domain-query 直调：复合键关联请走 ④ chat，或改用 schema 中 type:query 的等价函数" ;;
        missing)  die QUERY_FAILED "函数不存在: $fn。本本体的 query 函数: ${fn_info#*|}" ;;
      esac
    fi
  fi
  [ "$http_code" = "200" ] || die QUERY_FAILED "domain-query HTTP $http_code: $fn（函数不存在或参数不合法；可用 schema 输出的 YAML 核对函数签名）"
  # 引擎可能 200 + body code 错误（对齐 sandbox CLI 防御）
  body_code=$(printf '%s' "${body%$'\n'*}" | python3 -c '
import json, sys
try:
    print(json.load(sys.stdin).get("code", 0) or 0)
except Exception:
    print(0)')
  case "$body_code" in
    0|200) ;;
    *) die QUERY_FAILED "domain-query 引擎错误 code=$body_code: $fn" ;;
  esac
  local resp_file
  resp_file=$(mktemp /tmp/onto_resp.XXXXXX)
  printf '%s' "${body%$'\n'*}" > "$resp_file"
  result_json=$(python3 - "$fn" "$resp_file" <<'PY'
import json, os, sys
r = json.load(open(sys.argv[2]))
data = r.get("data")
result = data.get("result") if isinstance(data, dict) else data
if result is None:
    result = []
res = {"success": True, "function": sys.argv[1],
       "count": len(result) if isinstance(result, list) else None, "result": result}
if isinstance(result, list):
    # 行数 cap：防大结果集涌入 LLM 上下文（rm_res_intfip 8.2 万行量级）
    cap = int(os.environ.get("ONTO_MAX_ROWS", "200"))
    if len(result) > cap:
        total = len(result)
        result = result[:cap]
        res["count"] = cap
        res["total_count"] = total
        res["truncated"] = True
        res["hint"] = f"结果已截断：共 {total} 行，仅返回前 {cap} 行。请缩小过滤条件（加 limit/精确过滤）分批查询"
if isinstance(result, list) and len(result) == 0:
    # 尖刺 3：空结果 ≠ 建模错误
    res["hint"] = "空结果≠建模错误：先怀疑数据边界（如逻辑接口不在物理端口表），勿据此否定 schema 结论"
print(json.dumps(res, ensure_ascii=False))
PY
) || { rm -f "$resp_file"; die QUERY_FAILED "domain-query 响应解析失败: $fn"; }
  rm -f "$resp_file"
  out "$result_json"
}

# ---------- ④ chat ----------
# create_session <file> → 新建服务端会话，stdout 输出 sessionId（失败输出空）
create_session() {
  curl -sS --connect-timeout 10 --max-time 30 -X POST "$BASE/api/agent/sessions" \
    -H "x-sys-code: $TENANT" -H "currentnetuserid: $USER_HEADER" -H "Content-Type: application/json" \
    -d "{\"dslFile\": $(json_str "$1")}" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin).get("sessionId",""))' 2>/dev/null || true
}

cmd_chat() {
  local file="${1:-}" question="${2:-}"
  # 单参数形态：chat "问题" → 用默认本体；标准形态：chat <file> "问题"
  if [ -n "$file" ] && [ -z "$question" ]; then
    question="$file"; file="$DEFAULT_FILE"
  fi
  [ -n "$file" ] || file="$DEFAULT_FILE"
  [ -n "$question" ] || die USAGE "用法: ontology_ask.sh chat <file> \"问题\" ｜ 或 chat \"问题\"（用默认本体）"
  gate "$file" >/dev/null
  local sess_file sid
  sess_file="$(cache_dir)/sessions.json"
  mkdir -p "$(dirname "$sess_file")"
  sid=$(python3 - "$sess_file" "$file" "$SESSION_TTL_MIN" <<'PY'
import json, sys, time
try:
    s = json.load(open(sys.argv[1]))
except Exception:
    sys.exit(0)
e = s.get(sys.argv[2]) or {}
if e and time.time() - e.get("lastUsed", 0) < int(sys.argv[3]) * 60:
    print(e.get("sid", ""))
PY
)
  if [ -z "$sid" ]; then
    sid=$(create_session "$file")
    [ -n "$sid" ] || die CHAT_FAILED "创建会话失败: $file"
  fi
  local body http_code answer attempt
  body=""
  # 5xx（实测偶发网关 504）重试；404（会话服务端过期/回收）弃缓存重建会话重试——均各 1 次
  for attempt in 1 2; do
    if body=$(curl -sS --connect-timeout 10 --max-time "${ONTO_CHAT_TIMEOUT:-120}" -w "\n%{http_code}" \
      -X POST "$BASE/api/agent/sessions/$sid/chat" \
      -H "x-sys-code: $TENANT" -H "currentnetuserid: $USER_HEADER" -H "Content-Type: application/json" \
      -d "{\"message\": $(json_str "$question")}"); then
      http_code="${body##*$'\n'}"
      case "$http_code" in
        2*) break ;;
        404)
          if [ "$attempt" = "1" ]; then
            sid=$(create_session "$file")
            [ -n "$sid" ] || die CHAT_FAILED "会话失效且重建失败: $file"
          else
            break
          fi ;;
        5*) [ "$attempt" = "2" ] && break ;;  # 末次尝试保留错误码走统一报错
        *) break ;;
      esac
    else
      [ "$attempt" = "2" ] && die CHAT_FAILED "chat 请求失败（会话 $sid 已保留，可重试）"
    fi
  done
  http_code="${body##*$'\n'}"
  [ "$http_code" = "200" ] || die CHAT_FAILED "chat HTTP $http_code（会话 $sid，5xx/会话失效已自动处理 1 次）"
  answer=$(printf '%s' "${body%$'\n'*}" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("answer",""))') \
    || die CHAT_FAILED "chat 响应解析失败（会话 $sid）"
  python3 - "$sess_file" "$file" "$sid" <<'PY'
import json, sys, time
try:
    s = json.load(open(sys.argv[1]))
except Exception:
    s = {}
s[sys.argv[2]] = {"sid": sys.argv[3], "lastUsed": time.time()}
json.dump(s, open(sys.argv[1], "w"))
PY
  out "{\"success\":true,\"file\":$(json_str "$file"),\"sessionId\":$(json_str "$sid"),\"answer\":$(json_str "$answer")}"
}

# ---------- 入口 ----------
cmd="${1:-}"
shift || true
case "$cmd" in
  discover) cmd_discover "$@" ;;
  schema)   cmd_schema "$@" ;;
  query)    cmd_query "$@" ;;
  chat)     cmd_chat "$@" ;;
  ""|-h|--help|help)
    sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^#\{1,\} \{0,1\}//'
    ;;
  *) die USAGE "未知子命令: $cmd（可选 discover|schema|query|chat）" ;;
esac
