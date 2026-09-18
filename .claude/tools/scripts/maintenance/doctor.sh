#!/usr/bin/env bash
# doctor.sh — rd_harness 只读健康自检（不自动修复，只报告）
#
# 用法: bash .claude/tools/scripts/maintenance/doctor.sh [root]
#   root 缺省为脚本所在仓库根（安装后项目从自身位置解析）；传参用于测试
#
# 检查项（对应 install-pipeline 自检场景）:
#   1. node 可用
#   2. .harness/.harness-version 格式 + 签名（sha256(version+"rd-harness-v2") 前 8 位）
#   3. 当前 backend 的配置文件存在 + hooks 文件可解析且 hooks.PreToolUse 已注册
#      （文件名从 tools/scripts/generate/targets.json 查表，随 backend 而变，非固定 settings.json）
#   4. harness-rules.yaml 可解析（复用 rd-auto yaml-parser）
#   5. rd-auto 脚本语法（orchestrator.js + lib/*.js）
#   6. skills 目录完整（每个 skill 目录含 SKILL.md）
#
# 退出码: 0 全部通过；1 存在失败项
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="${1:-$(cd "$SCRIPT_DIR/../../../.." && pwd)}"
# backend 目录：git config harness.backend-dir > .claude（同 setup-harness.sh --check 的解析方式）
HARNESS_DIR="$(git -C "$ROOT" config harness.backend-dir 2>/dev/null || echo .claude)"
# Node 专用路径：Windows Git Bash 下 $ROOT 是 MinGW 形式（/d/xxx），bash 的 test -f 能识别，
# 但原样内插进 node -e 后 Windows Node 按「当前盘符+路径」解析（/d/xxx → D:\d\xxx）→ ENOENT，
# 检查 3/4 在 Windows 下 100% 误报（Issue !255）。cygpath -m 转混合形式（D:/xxx）；
# Linux/macOS 无 cygpath，回退原 POSIX 路径（行为与原逻辑一致）。
NODE_ROOT="$(cygpath -m "$ROOT" 2>/dev/null || echo "$ROOT")"

PASS=0
FAIL=0

check() { # check <名称> <结果: 0=pass>
  if [ "$2" -eq 0 ]; then
    echo "  [PASS] $1"
    PASS=$((PASS + 1))
  else
    echo "  [FAIL] $1"
    FAIL=$((FAIL + 1))
  fi
}

echo "rd_harness doctor — root: $ROOT"
echo ""

# 1. node
command -v node >/dev/null 2>&1
check "node 可用" $?

# 2. .harness/.harness-version 格式 + 签名
VERSION_FILE="$ROOT/.harness/.harness-version"
if [ -f "$VERSION_FILE" ]; then
  VERSION="$(sed -n '1p' "$VERSION_FILE" | tr -d '[:space:]')"
  SIG="$(sed -n '3p' "$VERSION_FILE" | tr -d '[:space:]')"
  EXPECTED="$(printf '%s' "${VERSION}rd-harness-v2" | { command -v sha256sum >/dev/null 2>&1 && sha256sum || shasum -a 256 2>/dev/null || openssl dgst -sha256; } 2>/dev/null | grep -oE '[0-9a-f]{64}' | head -1 | cut -c1-8)"
  if [ -n "$VERSION" ] && [ "$SIG" = "$EXPECTED" ]; then
    check "harness-version 格式+签名一致 ($VERSION)" 0
  else
    echo "  [FAIL] harness-version 签名不匹配 (file=$SIG expected=$EXPECTED version=$VERSION)"
    FAIL=$((FAIL + 1))
  fi
else
  echo "  [FAIL] 缺少 $VERSION_FILE"
  FAIL=$((FAIL + 1))
fi

# 3. backend 配置文件可解析 + hooks 注册
# 文件名随 backend 变化（settings.json 只是 claude/codebuddy/qoder 的形态），硬编码会让
# 其他 backend 100% 误报"缺少 settings.json"（Issue !260）。唯一事实源是 generator 的
# targets.json：source 段声明框架自身，targets.<name> 段声明每个 backend 的 configFile /
# hooksFile（无 hooksFile 时 hooks 与 config 同文件）。这里只做查表，新增 backend 无需改本脚本。
# 定位顺序：backend 目录内 > 事实源目录（随 .framework-manifest 分发到每个业务仓）> 脚本同级。
# generator 不把 generate/ 复制进 backend 目录，所以事实源那份是安装后的常规命中点。
# 事实源目录不做硬编码：generator 复制资产时会把源目录字面量 blanket 改写为
# $HARNESS_ROOT/，导致非 claude backend 三条候选坍缩 → 100% 误报（Issue !270）。
# 改为运行时从 .framework-manifest 的 d 条目解析（manifest 恒随框架分发，内容不被改写）。
SRC_DIR="$(sed -n 's|^d \([.a-zA-Z0-9_-]*\)/tools/scripts$|\1|p' "$ROOT/.framework-manifest" 2>/dev/null | head -1)"
SRC_DIR="${SRC_DIR:-.claude}"
TARGETS_JSON=""
_prev=""
for _cand in "$ROOT/$HARNESS_DIR/tools/scripts/generate/targets.json" \
             "$ROOT/$SRC_DIR/tools/scripts/generate/targets.json" \
             "$SCRIPT_DIR/../generate/targets.json"; do
  [ "$_cand" = "$_prev" ] && continue  # 候选去重：SRC_DIR 与 HARNESS_DIR 相同时不重复探测
  _prev="$_cand"
  [ -f "$_cand" ] && { TARGETS_JSON="$_cand"; break; }
done
unset _prev

CONFIG_ERR=""
CONFIG_LABEL="backend 配置 + hooks 注册"
if [ -z "$TARGETS_JSON" ]; then
  CONFIG_ERR="无法定位 targets.json（backend 配置布局事实源），已查找 $HARNESS_DIR/ 与 $SRC_DIR/ 下的 tools/scripts/generate/"
else
  # 同检查 4 的理由：node 需要 cygpath -m 混合路径，MinGW 形式会被 Windows Node 误解析（Issue !255）
  NODE_TARGETS="$(cygpath -m "$TARGETS_JSON" 2>/dev/null || echo "$TARGETS_JSON")"
  # 输出 "OK|<configFile>|<hooksFile>" 或 "ERR|<原因>"（始终 exit 0，避免 stderr 栈回溯混入）
  LAYOUT="$(node -e '
    const fs = require("node:fs");
    const [manifestPath, dir] = process.argv.slice(1);
    try {
      const m = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      const roots = [];
      let cfg = null, hooks = null;
      if (m.source && m.source.rootDir) {
        roots.push(m.source.rootDir);
        if (m.source.rootDir === dir) { cfg = m.source.settings; hooks = m.source.settings; }
      }
      for (const t of Object.values(m.targets || {})) {
        if (!t || !t.rootDir) continue;
        roots.push(t.rootDir);
        if (t.rootDir === dir && !cfg) { cfg = t.configFile; hooks = t.hooksFile || t.configFile; }
      }
      if (!cfg) throw new Error("targets.json 未声明 backend 目录 " + dir + "（已声明: " + roots.join(", ") + "）");
      process.stdout.write("OK|" + cfg + "|" + hooks);
    } catch (e) {
      process.stdout.write("ERR|" + String(e && e.message).split("\n")[0]);
    }
  ' "$NODE_TARGETS" "$HARNESS_DIR" 2>/dev/null)"
  if [ "${LAYOUT%%|*}" = "OK" ]; then
    CONFIG_FILE="$(printf '%s' "$LAYOUT" | cut -d'|' -f2)"
    HOOKS_FILE="$(printf '%s' "$LAYOUT" | cut -d'|' -f3)"
    CONFIG_LABEL="$CONFIG_FILE 存在 + $HOOKS_FILE hooks.PreToolUse 已注册"
    [ "$CONFIG_FILE" = "$HOOKS_FILE" ] && CONFIG_LABEL="$CONFIG_FILE 可解析 + hooks.PreToolUse 已注册"
    if [ ! -f "$ROOT/$CONFIG_FILE" ]; then
      CONFIG_ERR="缺少 $ROOT/$CONFIG_FILE"
    elif [ ! -f "$ROOT/$HOOKS_FILE" ]; then
      CONFIG_ERR="缺少 $ROOT/$HOOKS_FILE"
    else
      # 同 LAYOUT 的约定：node 自行兜住异常并输出单行 "OK" / "ERR|<原因>"，
      # 免得 JSON.parse 的多行栈回溯整段灌进体检报告（原实现把 2>&1 直接拼进 FAIL 提示）。
      HOOKS_OK="$(node -e '
        const fs = require("node:fs");
        try {
          const s = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
          const hooks = s.hooks && s.hooks.PreToolUse;
          if (!Array.isArray(hooks) || hooks.length === 0) throw new Error("hooks.PreToolUse 未注册（缺失或空数组）");
          process.stdout.write("OK");
        } catch (e) {
          process.stdout.write("ERR|" + String(e && e.message).split("\n")[0]);
        }
      ' "$NODE_ROOT/$HOOKS_FILE" 2>/dev/null)"
      case "$HOOKS_OK" in
        OK) ;;
        ERR\|*) CONFIG_ERR="$HOOKS_FILE ${HOOKS_OK#ERR|}" ;;
        *) CONFIG_ERR="$HOOKS_FILE 检查失败：node 未返回结果" ;;
      esac
    fi
  else
    CONFIG_ERR="${LAYOUT#ERR|}"
    [ -n "$CONFIG_ERR" ] || CONFIG_ERR="targets.json 查表失败: $TARGETS_JSON"
  fi
fi
[ -z "$CONFIG_ERR" ]
check "$CONFIG_LABEL" $?
[ -n "$CONFIG_ERR" ] && echo "        $CONFIG_ERR"

# 4. harness-rules.yaml 可解析
RULES="$ROOT/$HARNESS_DIR/reference/harness-rules.yaml"
if [ -f "$RULES" ]; then
  # ESM import specifier 必须是 URL：裸路径在 Windows 抛 ERR_UNSUPPORTED_ESM_URL_SCHEME（Issue !251）。
  # 用 pathToFileURL 把 $NODE_ROOT 下的路径转成合法 file:// URL（自动处理盘符/分隔符/转义），
  # 配合动态 import 加载 yaml-parser；readFileSync 接受 D:/xxx 混合形式。
  node --input-type=module -e "
    import { pathToFileURL } from 'node:url';
    import { readFileSync } from 'node:fs';
    const parserUrl = pathToFileURL('$NODE_ROOT/$HARNESS_DIR/skills/rd-auto/scripts/lib/yaml-parser.js').href;
    const { parseYaml } = await import(parserUrl);
    const y = parseYaml(readFileSync('$NODE_ROOT/$HARNESS_DIR/reference/harness-rules.yaml', 'utf8'));
    process.exit(y && y.local_orchestrator ? 0 : 1);
  " >/dev/null 2>&1
  check "harness-rules.yaml 可解析（含 local_orchestrator）" $?
else
  echo "  [FAIL] 缺少 $RULES"
  FAIL=$((FAIL + 1))
fi

# 5. rd-auto 脚本语法
SYNTAX_FAIL=0
for js in "$ROOT/$HARNESS_DIR/skills/rd-auto/scripts/orchestrator.js" "$ROOT/$HARNESS_DIR/skills/rd-auto/scripts/lib/"*.js; do
  [ -f "$js" ] || continue
  node --check "$js" >/dev/null 2>&1 || { echo "        语法错误: $js"; SYNTAX_FAIL=1; }
done
check "rd-auto 脚本语法（orchestrator + lib）" $SYNTAX_FAIL

# 6. skills 目录完整
SKILLS_FAIL=0
SKILL_COUNT=0
for d in "$ROOT/$HARNESS_DIR/skills"/*/; do
  [ -d "$d" ] || continue
  SKILL_COUNT=$((SKILL_COUNT + 1))
  [ -f "$d/SKILL.md" ] || { echo "        缺 SKILL.md: $d"; SKILLS_FAIL=1; }
done
[ "$SKILL_COUNT" -gt 0 ] || SKILLS_FAIL=1
check "skills 目录完整（$SKILL_COUNT 个 skill 均含 SKILL.md）" $SKILLS_FAIL

echo ""
echo "结果: $PASS 通过, $FAIL 失败"
[ "$FAIL" -eq 0 ]
