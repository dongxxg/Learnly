---
name: upgrade-harness
version: 1.0.0
description: 安装harness、升级harness、upgrade harness, 更新harness, /upgrade-harness
user_invocable: true
---

# 框架升级技能

## 触发场景

- Session 启动时 hook 检测到版本不一致（MAJOR 阻断 / MINOR 建议升级 / PATCH 可选）
- PM 主动执行 `/upgrade-harness`

## 内部常量

| 常量 | 值 |
|------|-----|
| INSTALL_URL | `http://192.168.118.247:49157/harness/install.sh` |
| RAW_BASE | `http://192.168.5.160/public_group/rd_harness/-/raw/main` |

> **RAW_BASE 与 INSTALL_URL 保持一致**：RAW_BASE 的分支（`main`）必须与 install.sh 中 `HARNESS_BRANCH` 的稳定版本一致。install.sh 可能在开发期使用临时分支（如 `feature/530`），但 `main` 是发布分支，版本文件始终存在。

### 安装类型（`--type`）

install.sh 接受 `--type / -t` 指定目标 backend，**决定升级后生成哪个 agent 目录**：

| `--type` 值 | 生成的目录 | `HARNESS_BACKEND` | 备注 |
|-------------|-----------|-------------------|------|
| `codebuddy` | `.codebuddy` | `codebuddy` | 只生成 codebuddy；保留 .claude 以保护用户文件 |
| `codex` | `.codex` | `codex` | 只生成 codex；保留 .claude 以保护用户文件 |
| `qoder` | `.qoder` | `qoder` | 只生成 Qoder CN CLI 配置；保留 .claude 以保护用户文件 |
| `zcode` | `.zcode` | `zcode` | 生成 ZCode 本地插件，并通过 `plugins.dirs` 自动注册 Skills、Agents 与 Hooks |
| `claude` | `.claude` | `claude`（默认） | 只生成/覆盖 .claude |
| `all` | `.codebuddy` + `.codex` + `.qoder` + `.zcode` | `claude`（生成阶段） | 生成全部派生 backend；保留 .claude 以保护用户文件 |

> **探测链与 `--type` 的关系**：探测链产出 ∈ `{claude, codex, codebuddy, qoder, zcode}` 才算自动探测成功；`all` **不作为自动探测产物**，仅由用户显式 select 或 `--type all` 传入。探测链**完全不读 `.harness/.installed-backend` 标记**（标记仅供 `setup-harness.sh do_check` 跳过 .claude 存在性校验，独立用途；`finalize_backend` 仍写 marker）。
>
> **关键约束**：如果当前项目是单一 backend（只有 `.codebuddy/`、`.codex/`、`.qoder/` 或 `.zcode/`），裸跑 `curl | bash` 不传 `--type` 会触发探测链或 select 菜单；多 backend 目录并存（all 残留）会强制弹 select 让用户决策。**升级流程必须先检测当前 backend，再透传 `--type`。**

#### 后端检测逻辑

升级前按以下顺序探测当前项目使用的 backend，将结果记为 `$CURRENT_TYPE`（自动探测成功时取值 `codebuddy` | `codex` | `qoder` | `zcode` | `claude`；多目录并存或全 miss 时弹 select 菜单让用户选，用户可选 `all`）：

```bash
# 层 1: env 层（AI CLI 原生变量，最权威）
#   不检测 HARNESS_BACKEND（框架 generator 注入，对部分 CLI 子进程不可见，来源不对称）
#   ZCode 没有文档化的主会话环境变量，因此从目录/git config 层开始识别
#   env 命中后 MUST 追加目录存在性校验；目录缺失视为该层 miss，继续下层
env_detected=""
if [ -n "${CLAUDECODE:-}${CLAUDE_PROJECT_DIR:-}${CLAUDE_CODE_SESSION_ID:-}" ]; then
  env_detected="claude"
elif [ -n "${CODEX_HOME:-}${CODEX:-}${CODEX_VERSION:-}" ]; then
  env_detected="codex"
elif [ -n "${CODEBUDDY_SESSION_ID:-}${CODEBUDDY_PROJECT_DIR:-}" ]; then
  env_detected="codebuddy"
elif [ -n "${QODER_PROJECT_DIR:-}${QODER_SESSION_ID:-}${QODER_CLI:-}" ]; then
  env_detected="qoder"
fi
if [ -n "$env_detected" ] && [ -d ".$env_detected" ]; then
  CURRENT_TYPE="$env_detected"
fi
# env 层 miss（变量未设 / 对应目录缺失）→ 继续下层

# 层 2: 多目录并存检测（all 残留强信号，优先于 git config 防错配）
#   用变量循环或无斜杠 .claude 写法，避免 generator 重写规则破坏多目录检测
_dir_count=0
for bd in claude codebuddy codex qoder zcode; do
  [ -d ".$bd" ] && _dir_count=$((_dir_count + 1))
done

# 层 3: git config harness.backend-dir（去前导 .，白名单 + 目录存在双校验）
# 层 4: 单目录存在性兜底（仅一个 backend 目录存在）
# 层 5: 全 miss 或多目录并存 → install.sh 弹 select 菜单（选项 claude codex codebuddy qoder zcode all）
```

**对应 install.sh 的 `detect_current_backend(target)` 行为**（AI 升级时让 install.sh 自己跑探测链，不要手写脚本覆盖）：

| 层 | 信号 | 命中条件 | 产出 |
|----|------|---------|------|
| 1 | env | AI CLI 原生变量非空 **AND** 对应目录存在 | `{claude, codex, codebuddy, qoder}` 之一 |
| 2 | 多目录并存 | `.claude` / `.codebuddy` / `.codex` / `.qoder` / `.zcode` ≥2 个存在 | **触发 select**（视为歧义，不静默默认） |
| 3 | git config | `harness.backend-dir` ∈ {.claude, .codebuddy, .codex, .qoder, .zcode} **AND** 目录存在 | 对应 backend 名 |
| 4 | 单目录 | 仅一个 backend 目录存在 | 该 backend 名 |
| 5 | 全 miss | 上述全 miss | **触发 select** |

**白名单外结果的处理（关键约束）**：探测白名单外的结果（多目录并存、env 全 miss、git config 未知值、select 触发）MUST 指引 AI **向 PM 提问确认**目标 backend，MUST NOT 自动选默认值。这是为了避免静默错配（典型场景：`all` 项目升级被静默降级为 `codex-only`，丢失 codebuddy）。

## 执行流程

### 1. 版本对比，等 PM 确认

**PM 确认前不得执行任何文件操作。**

从本地 `.harness/.harness-version` 读取当前版本，curl 拉取远端版本：

```bash
curl -s --connect-timeout 5 --max-time 10 \
  "${RAW_BASE}/.harness/.harness-version"
```

向 PM 展示版本差异，并拉取 CHANGELOG：

```bash
curl -s --connect-timeout 5 --max-time 10 \
  "${RAW_BASE}/CHANGELOG.md"
```

展示格式：

```
当前版本: 1.16.0
目标版本: 1.16.1
强制升级: 是

v1.16.1 变更内容:
  - SessionStart 版本升级检测
  - 版本签名防篡改
  ...
```

等 PM 明确确认。

### 2. 执行升级

升级前必须先检测当前 backend，透传 `--type`，避免裸跑默认探测链在多目录并存或 CI 无 TTY 场景下阻塞或错配（详见上方「安装类型」）。

按「后端检测逻辑」算出 `$CURRENT_TYPE`（来自 env / 多目录并存 / git config / 单目录探测 / select 菜单），向 PM 展示后将升级命令与 changelog 一并确认：

```
即将升级：
  版本：1.16.0 → 1.17.0
  当前 backend：$CURRENT_TYPE（来自 env/git config/目录探测/select 菜单）
  执行：curl -s ... | bash -s -- --type $CURRENT_TYPE
```

> **白名单外结果的处理**：若探测得到多目录并存信号（典型 `all` 残留）、env 全 miss、或 git config 未知值，**MUST 向 PM 提问确认**目标 backend（选 `claude` / `codex` / `codebuddy` / `qoder` / `zcode` / `all` 之一），**MUST NOT** 自动选默认值。select 菜单触发时让 PM 在终端显式选择。

等 PM 确认后执行：

```bash
curl -s http://192.168.118.247:49157/harness/install.sh | bash -s -- --type "$CURRENT_TYPE"
```

upgrade 完成后，验证版本号与签名：

```bash
# 验证签名
SIGN_SALT="rd-harness-v2"
LOCAL_VERSION=$(head -1 .harness/.harness-version)
LOCAL_SIG=$(sed -n '3p' .harness/.harness-version)
EXPECTED_SIG=$(printf '%s' "${LOCAL_VERSION}${SIGN_SALT}" | { command -v sha256sum >/dev/null 2>&1 && sha256sum || shasum -a 256 2>/dev/null || openssl dgst -sha256; } 2>/dev/null | grep -oE '[0-9a-f]{64}' | head -1 | cut -c1-8)
[ "$LOCAL_SIG" = "$EXPECTED_SIG" ] && echo "签名验证通过" || echo "签名验证失败"
```

### 3. 完整性验证

```bash
# 完整性验证（自动检测 backend 目录；非 claude 类型指向对应 backend 目录）
_HARNESS_DIR="$(git config harness.backend-dir 2>/dev/null || echo .claude)"
HARNESS_ROOT="$_HARNESS_DIR" bash "$_HARNESS_DIR/tools/scripts/setup/setup-harness.sh" --check
```

> **非 claude 类型注意**：`--type codebuddy/codex/qoder/zcode` 升级后 `finalize_backend` 会保留 `.claude` 以保护用户未跟踪文件，并将 `git config harness.backend-dir` 指向对应 backend 目录。完整性检查优先使用该配置；若配置缺失，则按「后端检测逻辑」重新确认 `$CURRENT_TYPE`，再 `_HARNESS_DIR=".$CURRENT_TYPE"` 显式指定。`do_check` 内部仍读 `.harness/.installed-backend` 标记跳过 Claude 专属检查。

确认 integrity 行显示 `verified`，向 PM 报告结果：

```
升级完成: 1.7.1 → 1.8.0
版本文件已更新: .harness/.harness-version = 1.8.0
backend 目录: .codebuddy/（--type codebuddy）
```

随后运行 doctor 深度自检（版本签名 / hooks 注册 / rules 解析 / 脚本语法 / skills 完整性，只读不修复）：

```bash
bash "$_HARNESS_DIR/tools/scripts/maintenance/doctor.sh"
```

任一 `[FAIL]` 项须原样报告 PM，不得静默跳过或自行修复。

### 4. 提示重启 Session

升级完成后，框架文件（hooks、rules、skills）已更新，但当前 session 仍使用旧版本。须提示 PM：

```
升级完成。框架文件已更新，请退出当前 session 并重新进入以加载新版。
```

## 升级保护规则（红线）

以下文件属于项目状态，**升级时禁止覆盖**。`setup-harness.sh` 通过 `.framework-manifest` 驱动的拷贝机制自动保护，只覆盖 manifest 内的文件：

| 目录/文件 | 说明 |
|-----------|------|
| `CLAUDE.md` | 项目级配置（只创建不覆盖） |
| `.harness/spec/` | SPEC 工作区 |
| `.harness/knowledge/` | 项目知识库 |
| `.harness/memory/` | 项目记忆 |
| `.claude/settings.local.json` | 本地设置 |
| `.claude/skills/*/.daily-report-config` | 日报技能配置 |
| `.gitlab-config` | GitLab 令牌 |

## 执行规则

1. **PM 确认前置**：展示版本差异后，等 PM 明确确认
2. **只覆盖框架核心**：setup-harness.sh 通过 manifest 保护项目状态文件
3. **升级后验证版本**：确认 `.harness/.harness-version` 已更新
4. **失败不回滚**：升级失败时报告错误，由 PM 决定后续操作
