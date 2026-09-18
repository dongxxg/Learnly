#!/usr/bin/env bash
# SessionStart hook: 框架完整性校验 + 上下文注入（统一版 Claude/Codex/CodeBuddy/Qoder/ZCode）
# 同时服务于各 coding agent（.claude/hooks/shared/ 由 generator 拷贝到各 backend 的 hooks/shared/）
set -uo pipefail
# 注：不用 set -e，hook runner 对 errexit 后的 exit code 判断有特殊性。
# 任何子命令失败也不应导致 hook 整体以非零退出。

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/hook-json-helper.sh"

# ── 后端检测 ──
detect_backend() {
  # HARNESS_BACKEND 由 generator 注入，是最权威信号；Qoder 原生项目变量次之。
  case "${HARNESS_BACKEND:-}" in
    claude|codex|codebuddy|qoder|zcode)
      echo "$HARNESS_BACKEND"
      return
      ;;
  esac
  if [ -n "${QODER_PROJECT_DIR:-}${QODER_SESSION_ID:-}" ]; then
    echo "qoder"
  elif [ -n "${CLAUDE_CODE_SESSION_ID:-}" ]; then
    echo "claude"
  elif [ -n "${CODEBUDDY_PROJECT_DIR:-}${CODEBUDDY_SESSION_ID:-}" ]; then
    echo "codebuddy"
  elif [ -d .zcode ] && [ ! -d .claude ] && [ ! -d .codex ] && [ ! -d .codebuddy ] && [ ! -d .qoder ]; then
    echo "zcode"
  elif [ -d .qoder ] && [ ! -d .claude ] && [ ! -d .codex ] && [ ! -d .codebuddy ] && [ ! -d .zcode ]; then
    echo "qoder"
  elif command -v codex >/dev/null 2>&1; then
    echo "codex"
  elif command -v qoderclicn >/dev/null 2>&1; then
    echo "qoder"
  else
    echo "claude"
  fi
}
BACKEND=$(detect_backend)

# Codex/CodeBuddy/Qoder/ZCode 路径：REPO_ROOT 由 hooks 配置通过 env 注入，
# 或通过调用方的 CWD 推断（hook runner 通常在项目根执行）。
# Claude 路径：CLAUDE_PROJECT_DIR 由 Claude Code 设置。
PROJECT_DIR="${QODER_PROJECT_DIR:-${CLAUDE_PROJECT_DIR:-${REPO_ROOT:-$(pwd)}}}"

# 框架根目录（默认即本 agent 目录；generator 注入 HARNESS_ROOT 让其它 agent 复用同一框架目录）
HARNESS_ROOT="${HARNESS_ROOT:-.claude}"

# ── 1. 框架版本升级检测（各 backend 通用）──────────────────────────────
SIGN_SALT="rd-harness-v2"
MARKER_FILE="$PROJECT_DIR/.harness/.pending-upgrade-msg"

# 跨平台 SHA256 hex（Issue !248）：macOS 无 sha256sum（GNU coreutils），用
# shasum -a 256 / openssl 兜底；统一 grep 取 64-hex，规避各工具输出格式差异。
harness_sha256_hex() {
  printf '%s' "$1" \
    | { command -v sha256sum >/dev/null 2>&1 && sha256sum || shasum -a 256 2>/dev/null || openssl dgst -sha256; } 2>/dev/null \
    | grep -oE '[0-9a-f]{64}' | head -1
}

# 源仓库豁免：当前仓库即 rd_harness 自身时，本地领先 main 是开发期常态
if git -C "$PROJECT_DIR" remote -v 2>/dev/null | grep -q 'public_group/rd_harness'; then
  rm -f "$MARKER_FILE" 2>/dev/null || true
else
  REMOTE_VERSION_FILE=$(curl -s --connect-timeout 3 \
    "http://192.168.5.160/public_group/rd_harness/-/raw/main/.harness/.harness-version" 2>/dev/null || echo "")

  LOCAL_VERSION=$(cat "$PROJECT_DIR/.harness/.harness-version" 2>/dev/null | head -1 || echo "0")
  LOCAL_SIG=$(sed -n '3p' "$PROJECT_DIR/.harness/.harness-version" 2>/dev/null || echo "")
  EXPECTED_SIG=$(harness_sha256_hex "${LOCAL_VERSION}${SIGN_SALT}" | cut -c1-8)

  if [ "$LOCAL_SIG" != "$EXPECTED_SIG" ]; then
    printf "Uni-AURI 必须升级: 版本文件被篡改 — 运行 /upgrade-harness 升级框架\n" > "$MARKER_FILE"
  elif [ -n "$REMOTE_VERSION_FILE" ]; then
    REMOTE_VERSION=$(echo "$REMOTE_VERSION_FILE" | head -1)
    REMOTE_FORCE=$(echo "$REMOTE_VERSION_FILE" | head -2 | tail -1)

    if [ "$LOCAL_VERSION" = "$REMOTE_VERSION" ]; then
      rm -f "$MARKER_FILE" 2>/dev/null || true
    elif [ "$REMOTE_FORCE" = "force" ]; then
      printf "Uni-AURI 必须升级: 远程 %s / 当前 %s — 运行 /upgrade-harness 升级框架\n" \
        "$REMOTE_VERSION" "$LOCAL_VERSION" > "$MARKER_FILE"
    elif [ "$(printf '%s\n%s\n' "$LOCAL_VERSION" "$REMOTE_VERSION" | sort -V | head -1)" = "$LOCAL_VERSION" ]; then
      printf "Uni-AURI 新版本可用: 远程 %s / 当前 %s — 运行 /upgrade-harness 升级框架\n" \
        "$REMOTE_VERSION" "$LOCAL_VERSION" > "$MARKER_FILE"
    else
      rm -f "$MARKER_FILE" 2>/dev/null || true
    fi
  else
    rm -f "$MARKER_FILE" 2>/dev/null || true
  fi
fi

# ── 2. 清理跨 session 临时标记（各 backend 通用）────────────────────────
# marker 文件统一在 .harness/（项目级状态目录），同时清理旧位置残留（DBC-004）
# .framework-edit：目标项目清理（防 bypass 持久化）；框架源仓库保留（开发者本地 bypass）
# 源仓库判定复用 is_framework_source_repo 逻辑（install.sh 存在且被 git 跟踪）
if [ -f "$PROJECT_DIR/install.sh" ] && git -C "$PROJECT_DIR" ls-files --error-unmatch install.sh >/dev/null 2>&1; then
  : # 框架源仓库：保留 .framework-edit（开发者本地开发 bypass，见 governance memory）
else
  rm -f "$PROJECT_DIR/.harness/.framework-edit" 2>/dev/null || true
  rm -f "$PROJECT_DIR/.codex/.framework-edit" "$PROJECT_DIR/.codebuddy/.framework-edit" "$PROJECT_DIR/.qoder/.framework-edit" "$PROJECT_DIR/.zcode/.framework-edit" "$PROJECT_DIR/.claude/.framework-edit" 2>/dev/null || true

  # ── statusLine 路径自愈（非源仓库）──────────────────────────────────
  # 仓库 move 后 settings.json 内联的 statusLine 绝对路径失效 → 状态栏消失。
  # 启动时校准到当前位置（absolutize-statusline.cjs 幂等：相对形态绝对化 /
  # 旧绝对前缀重写 / 已正确则 no-op）。框架源仓库在上面 if 分支跳过
  # （.claude/settings.json 是 git 事实源，必须保持可移植相对路径）。
  # best-effort：node/脚本/settings 缺失一律静默跳过，绝不阻断 session 启动。
  # stdout 丢弃：SessionStart hook 的 stdout 会被注入上下文，成功日志不需要进 context。
  _sl_settings="$PROJECT_DIR/$HARNESS_ROOT/settings.json"
  _sl_tool="$PROJECT_DIR/$HARNESS_ROOT/tools/scripts/setup/absolutize-statusline.cjs"
  if [ -f "$_sl_settings" ] && [ -f "$_sl_tool" ] && command -v node >/dev/null 2>&1; then
    node "$_sl_tool" "$_sl_settings" >/dev/null 2>&1 || true
  fi
fi
# push / branch 审批标记 + 旧位置残留合并为单次 rm（Windows Git Bash 下每次 fork ~1-2s，省 ~3 fork）
# 旧位置清理（升级兼容：marker 曾在 backend 目录，session 启动时一并清理）
rm -f "$PROJECT_DIR/.harness/.push-challenge" "$PROJECT_DIR/.harness/.push-approved" "$PROJECT_DIR/.codex/.push-challenge" "$PROJECT_DIR/.codebuddy/.push-challenge" "$PROJECT_DIR/.qoder/.push-challenge" "$PROJECT_DIR/.zcode/.push-challenge" "$PROJECT_DIR/.claude/.push-challenge" "$PROJECT_DIR/.codex/.push-approved" "$PROJECT_DIR/.codebuddy/.push-approved" "$PROJECT_DIR/.qoder/.push-approved" "$PROJECT_DIR/.zcode/.push-approved" "$PROJECT_DIR/.claude/.push-approved" "$PROJECT_DIR/.harness/.branch-challenge" "$PROJECT_DIR/.harness/.branch-approved" 2>/dev/null || true

# ── 3. Claude/ZCode：项目记忆同步到 backend 用户数据目录 ──────────────
if [ "$BACKEND" = "claude" ] || [ "$BACKEND" = "zcode" ]; then
  MEMORY_DIR="${PROJECT_DIR}/.harness/memory"
  MEMORY_MD="${MEMORY_DIR}/MEMORY.md"

  if [ -d "$MEMORY_DIR" ]; then
    _ABS_ROOT="$(cd "$PROJECT_DIR" && pwd)"
    if command -v cygpath &>/dev/null; then
      _ABS_ROOT="$(cygpath -m "$_ABS_ROOT")"
    fi
    _ENCODED="$(echo "$_ABS_ROOT" | sed 's/[:\\\/_]/-/g')"
    # HARNESS_PROJECTS_DIR 可能含字面 `$HOME`（generator 注入 settings.json env 块时
    # bash 不展开单引号内的 $HOME），用 _expand_home（定义在 hook-json-helper.sh）
    # 展开为真实 $HOME，否则 mkdir -p '$HOME/...' 会在 CWD 下创建字面 `$HOME` 目录。
    _raw_projects_dir="${HARNESS_PROJECTS_DIR:-$HOME/${HARNESS_ROOT:-.claude}/projects}"
    _BACKEND_MEM_DIR="$(_expand_home "$_raw_projects_dir")/${_ENCODED}/memory"
    _BACKEND_MEM_INDEX="$_BACKEND_MEM_DIR/MEMORY.md"
    mkdir -p "$_BACKEND_MEM_DIR" 2>/dev/null || true

    _synced=0
    for src_file in "$MEMORY_DIR"/*.md; do
      [ -f "$src_file" ] || continue
      _fname="$(basename "$src_file")"
      _dst_file="$_BACKEND_MEM_DIR/$_fname"
      if [ ! -f "$_dst_file" ]; then
        cp "$src_file" "$_dst_file"
        _synced=$((_synced + 1))
      else
        _src_ts=$(stat -c %Y "$src_file" 2>/dev/null || stat -f %m "$src_file" 2>/dev/null || echo 0)
        _dst_ts=$(stat -c %Y "$_dst_file" 2>/dev/null || stat -f %m "$_dst_file" 2>/dev/null || echo 0)
        if [ "$_src_ts" -gt "$_dst_ts" ]; then
          cp "$src_file" "$_dst_file"
          _synced=$((_synced + 1))
        fi
      fi
    done

    if [ -f "$MEMORY_MD" ]; then
      if [ ! -f "$_BACKEND_MEM_INDEX" ]; then
        cp "$MEMORY_MD" "$_BACKEND_MEM_INDEX"
      else
        while IFS= read -r line; do
          _key="$(echo "$line" | sed -n 's/.*(\([^)]*\.md\)).*/\1/p' 2>/dev/null || true)"
          [ -z "$_key" ] && continue
          if ! grep -q "$_key" "$_BACKEND_MEM_INDEX" 2>/dev/null; then
            echo "$line" >> "$_BACKEND_MEM_INDEX"
            _synced=$((_synced + 1))
          fi
        done < "$MEMORY_MD"
      fi
    fi
  fi
fi

# ── 4. 构建上下文（各 backend 通用）────────────────────────────────────
# 4a. 框架级 CLAUDE.md
CLAUDE_MD="${PROJECT_DIR}/$HARNESS_ROOT/reference/AGENTS.md"
CLAUDE_MD_TEXT=""
if [ -f "$CLAUDE_MD" ]; then
  CLAUDE_MD_TEXT=$(cat "$CLAUDE_MD" 2>/dev/null || true)
fi

# 4b. harness-rules 核心规则（roles + quality gates + scoring）
RULES_TEXT=""
RULES_FILE="$PROJECT_DIR/$HARNESS_ROOT/reference/harness-rules.yaml"
if [ -f "$RULES_FILE" ]; then
  # Roles — 单次 awk 扫描（替代 per-role grep×N fork 循环）
  # Windows Git Bash 下原实现每个候选 role 跑 2× `grep -A`（约 98 次 fork），叠加
  # 外层 `grep|sed`，整段实测 >120s（session 启动卡 5~6 分钟的主因）。改为单次 awk
  # 限定 roles: 段，1 次 fork 替代 200+。
  # 同时修正正确性：原 `^  [a-z_]+:$` 未限定在 roles: 段，匹配了全文件所有 2 空格
  # key（weights/thresholds 等），且 `grep -A` 的 `\s\s` 在 grep 下不可靠，导致产出
  # 垃圾（如 `**forbidden**: 职责=无 禁止=  forbidden:`）。awk 严格限定 roles: 段，
  # 仅取含 responsibilities/forbidden 的真实角色。输出用真实换行，再由 bash 转成
  # `\\n` 编码与下游 `printf '%b'` 渲染保持一致（roles 段尾随空行 + QG/scoring
  # 拼接格式不变）。
  # __ROLES_AWK_BEGIN__（测试锚点：test_session_start_rules_injection.sh）
  _ROLES_AWK_OUT=$(awk '
    BEGIN { in_roles=0; role=""; resp=""; forb="" }
    /^roles:[[:space:]]*$/ { in_roles=1; next }
    in_roles && /^[a-zA-Z_]+:[[:space:]]*$/ { in_roles=0 }
    in_roles && /^  [a-zA-Z_]+:[[:space:]]*$/ {
      if (role!="" && (resp!=""||forb!=""))
        printf "**%s**: 职责=%s 禁止=%s\n", role, (resp==""?"无":resp), (forb==""?"无":forb)
      role=$0; sub(/^  /,"",role); sub(/:[[:space:]]*$/,"",role); resp=""; forb=""; next
    }
    in_roles && role!="" && /^    [a-zA-Z_]+:/ {
      if ($0 ~ /responsibilities:/) { resp=$0; sub(/.*responsibilities:[[:space:]]*\[/,"",resp); sub(/\].*/,"",resp) }
      else if ($0 ~ /forbidden:/)   { forb=$0; sub(/.*forbidden:[[:space:]]*\[/,"",forb); sub(/\].*/,"",forb) }
    }
    END {
      if (role!="" && (resp!=""||forb!=""))
        printf "**%s**: 职责=%s 禁止=%s\n", role, (resp==""?"无":resp), (forb==""?"无":forb)
    }
  ' "$RULES_FILE" 2>/dev/null || true)
  # __ROLES_AWK_END__
  if [ -n "$_ROLES_AWK_OUT" ]; then
    RULES_TEXT="${_ROLES_AWK_OUT//$'\n'/\\n}\\n\\n"
  fi
  unset _ROLES_AWK_OUT

  # Quality gates
  QG_TEXT=""
  qg_id=""
  while IFS= read -r line; do
    case "$line" in
      *"- id: "*)
        qg_id="${line##*- id: }"
        ;;
      *"standard: "*)
        if [ -n "$qg_id" ]; then
          std="${line##*standard: }"
          std="${std%\"}"; std="${std#\"}"
          QG_TEXT="${QG_TEXT}${qg_id}: ${std}\\n"
          qg_id=""
        fi
        ;;
    esac
  done <<< "$(grep -E '^\s+- id:|^\s+standard:' "$RULES_FILE" 2>/dev/null || true)"
  if [ -n "$QG_TEXT" ]; then
    RULES_TEXT="${RULES_TEXT}## 质量门禁\\n${QG_TEXT}\\n"
  fi

  # Scoring thresholds
  SCORE_TEXT=""
  cond=""
  while IFS= read -r line; do
    cleansed="${line##*condition: }"
    if [ "$cleansed" != "$line" ]; then
      cond="$cleansed"
      cond="${cond%\"}"; cond="${cond#\"}"
    fi
    cleansed="${line##*label: }"
    if [ "$cleansed" != "$line" ] && [ -n "$cond" ]; then
      lbl="$cleansed"
      lbl="${lbl%\"}"; lbl="${lbl#\"}"
      SCORE_TEXT="${SCORE_TEXT}${cond} → ${lbl}\\n"
      cond=""
    fi
  done <<< "$(grep -E '^\s+- condition:|^\s+label:' "$RULES_FILE" 2>/dev/null || true)"
  if [ -n "$SCORE_TEXT" ]; then
    RULES_TEXT="${RULES_TEXT}## 评审标准\\n${SCORE_TEXT}"
  fi
fi

# 4d. 项目记忆索引（Claude/ZCode 注入 MEMORY.md；Codex 跳过以控制上下文）
MEMORY_INDEX=""
if [ "$BACKEND" = "zcode" ] && [ -f "${_BACKEND_MEM_INDEX:-}" ]; then
  # ZCode 不原生扫描插件数据目录，显式加载已合并的 user/feedback + project/reference 索引。
  MEMORY_INDEX=$(cat "$_BACKEND_MEM_INDEX" 2>/dev/null || true)
elif [ "$BACKEND" = "claude" ]; then
  MEMORY_MD="${PROJECT_DIR}/.harness/memory/MEMORY.md"
  if [ -f "$MEMORY_MD" ]; then
    MEMORY_INDEX=$(cat "$MEMORY_MD" 2>/dev/null || true)
  fi
fi

# ── 5. 按后端输出 ────────────────────────────────────────────────────
if [ "$BACKEND" = "codex" ] || [ "$BACKEND" = "zcode" ]; then
  # Codex/ZCode: JSON hookSpecificOutput 格式
  MEMORY_CONTEXT=""
  if [ "$BACKEND" = "zcode" ]; then
    MEMORY_CONTEXT="
=== 记忆 ===
用户记忆目录: ${_BACKEND_MEM_DIR:-未初始化}
项目记忆目录: ${PROJECT_DIR}/.harness/memory

=== 合并记忆索引（可通过 Read 工具查看详细内容） ===
${MEMORY_INDEX}
"
  fi
  CONTEXT="<EXTREMELY_IMPORTANT>
You are running with Uni-AURI.
Backend: ${BACKEND}.

=== 框架规则 ===
${CLAUDE_MD_TEXT}

=== 核心规则 ===
$(printf '%b' "$RULES_TEXT")
${MEMORY_CONTEXT}

=== 快速启动 ===
描述你的需求，AI 自动选择对应技能执行。
</EXTREMELY_IMPORTANT>"

  ESCAPED=$(printf '%s\n' "$CONTEXT" \
    | sed 's/\\/\\\\/g' \
    | sed 's/'"$(printf '\t')"'/\\t/g' \
    | sed 's/'"$(printf '\r')"'/\\r/g' \
    | sed 's/'"$(printf '\b')"'/\\b/g' \
    | sed 's/'"$(printf '\f')"'/\\f/g' \
    | sed 's/"/\\"/g' \
    | tr -d '\000-\010\016-\037\177' \
    | awk '{printf "%s\\n", $0}' \
    | sed 's/\\n$//' 2>/dev/null || true)

  printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":%s}}\n' "\"$ESCAPED\"" 2>/dev/null || true
else
  # Claude/CodeBuddy/Qoder: 直接输出文本注入上下文
  if [ -n "$CLAUDE_MD_TEXT" ]; then
    echo "" || true
    echo "$CLAUDE_MD_TEXT" || true
  fi

  if [ -n "$RULES_TEXT" ]; then
    echo "" || true
    printf '%b' "$RULES_TEXT" || true
  fi

  if [ -n "$MEMORY_INDEX" ]; then
    echo "" || true
    echo "# 项目记忆索引（可通过 Read 工具查看详细内容）" || true
    echo "$MEMORY_INDEX" || true
  fi
fi

exit 0
