# lib/json.sh — JSON helpers backed by python3 (replaces jq dependency).
#
# Why python3 over jq: the CI image (gitlab-runner-all-in-one) ships python3
# (pytest is a hard dep) but not jq. issue-board needs to run in both local
# dev (mac/linux) and CI; python3 is universally available.
#
# Convention: every helper reads JSON from stdin, writes result to stdout.
# Missing-key semantics mirror jq's `.field // "default"`: only `null` falls
# back to the default (empty string / "" / 0 are preserved as-is).

# json_py <python_code>
#   Generic entry. stdin = JSON document, code reads via sys.stdin.
#   Use for transforms not covered by the sugar helpers below.
#   Example: printf '%s' "$resp" | json_py 'print(json.load(sys.stdin)["title"])'
json_py() {
  python3 -c "import sys
for _s in ('stdin', 'stdout'):
    _st = getattr(sys, _s, None)
    _r = getattr(_st, 'reconfigure', None)
    if _r is not None:
        try: _r(encoding='utf-8', errors='replace')
        except Exception: pass
$1"
}

# json_get <path> [default]
#   Dotted-path field extraction. stdin = JSON object.
#   Returns the value at path, or default when any segment is missing/null.
#   Example: printf '%s' "$resp" | json_get 'assignee.username' '未指派'
json_get() {
  path="$1" default="${2:-}" python3 -c '
import sys, json, os
# !261: GBK 终端 stdin/stdout 重配置 utf-8（与 json_py 同款，打印中文 issue 标题不崩）
for _s in ("stdin", "stdout"):
    _st = getattr(sys, _s, None)
    _r = getattr(_st, "reconfigure", None)
    if _r is not None:
        try: _r(encoding="utf-8", errors="replace")
        except Exception: pass
d = json.load(sys.stdin)
v = d
for k in os.environ["path"].split("."):
    if v is None:
        break
    if isinstance(v, dict):
        v = v.get(k)
    elif isinstance(v, list):
        try:
            v = v[int(k)]
        except (ValueError, IndexError):
            v = None
            break
    else:
        v = None
        break
if v is None:
    v = os.environ.get("default", "")
print(v)
'
}

# json_get_list <path>
#   Like json_get, but returns one item per line for array values.
#   Missing path yields nothing (no output line).
#   Example: printf '%s' "$resp" | json_get_list 'labels'
json_get_list() {
  path="$1" python3 -c '
import sys, json, os
# !261: GBK 终端 stdin/stdout 重配置 utf-8（与 json_py 同款）
for _s in ("stdin", "stdout"):
    _st = getattr(sys, _s, None)
    _r = getattr(_st, "reconfigure", None)
    if _r is not None:
        try: _r(encoding="utf-8", errors="replace")
        except Exception: pass
d = json.load(sys.stdin)
v = d
for k in os.environ["path"].split("."):
    if v is None:
        break
    if isinstance(v, dict):
        v = v.get(k)
    elif isinstance(v, list):
        try:
            v = v[int(k)]
        except (ValueError, IndexError):
            v = None
            break
    else:
        v = None
        break
if isinstance(v, list):
    for item in v:
        print(item)
'
}

# json_len — length of top-level array/object. stdin = JSON.
json_len() {
  python3 -c 'import sys, json; print(len(json.load(sys.stdin)))'
}

# json_count <python_filter_expr>
#   Count items in top-level array matching the filter.
#   Filter expr receives each item as `x`.
#   Example: printf '%s' "$resp" | json_count 'x.get("state") == "opened"'
json_count() {
  expr="$1" python3 -c '
import sys, json, os
data = json.load(sys.stdin)
if not isinstance(data, list):
    print(0)
else:
    expr = os.environ["expr"]
    print(sum(1 for x in data if eval(expr, {"x": x})))
'
}

# json_pretty — pretty-print with 2-space indent, UTF-8 preserved.
json_pretty() {
  python3 -c '
import sys, json
# !261: GBK 终端 stdout 重配置 utf-8（ensure_ascii=False 打印中文不崩）
_r = getattr(sys.stdout, "reconfigure", None)
if _r is not None:
    try: _r(encoding="utf-8", errors="replace")
    except Exception: pass
print(json.dumps(json.load(sys.stdin), indent=2, ensure_ascii=False))
'
}

# json_url_encode — percent-encode for URL path component. stdin = raw string.
#   Equivalent to jq -sRr @uri. Encodes everything except [A-Za-z0-9].
json_url_encode() {
  python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.stdin.read().rstrip(), safe=""))'
}
