# Dispatch Flow — 详细 dispatch 流程

> 主会话在 dispatch sub-agent 阶段需要详细规则时 Read 本文件。
> 主 SKILL.md 已含 7 步循环骨架，本文件覆盖**模板选择、字段填充、per-phase 裁剪**细节。

## dispatch-prompt 命令输出字段

`node $SCRIPT dispatch-prompt <change-name>` 返回：

| 字段 | 用途 |
|------|------|
| `role` | 角色（architect/developer/tester/reviewer/debate） |
| `agent_path` | 角色定义文件路径（**模板禁止让 sub-agent Read**，已通过 validation.agent_file_content 提供） |
| `phase` | 当前阶段 |
| `change_name`, `title` | 任务标识 |
| `backend` | **分流信号源**：`{ type: "claude" \| "codex", name: <string> }`，主会话按 `type` 选择 dispatch 路径 |
| `acceptance_criteria` | 验收标准数组 |
| `previous_summary` | 前一阶段摘要（一句话） |
| `context_pack` | 按 phase 裁剪后的上下文包（含 spec_docs / harness_rules / git_diff / agent_history 等子字段） |
| `validation.agent_file_content` | **已展开的角色定义全文**（注入到模板 `<agent_definition>`） |
| `validation.passed` | agent 文件 >= 50 行校验 |

## 模板选择

| 场景 | 模板文件 |
|------|---------|
| 有 rd_skill（explore/propose/implement/archive） | `templates/dispatch-with-skill.md` |
| 无 rd_skill（test/code-review/debate） | `templates/dispatch-without-skill.md` |
| 返工（advance 返回 `next_action: "rework"`） | 对应阶段模板 + **末尾追加** `templates/dispatch-rework.md` |
| 设计评审（design-review 阶段） | `templates/dispatch-design-review.md`（对抗性审查） |
| 归档 | `templates/dispatch-archive.md` |
| 并行派发（team mode implement） | `templates/dispatch-fanout.md` |
| ADR 流程 | `templates/dispatch-adr.md` |

## 有 rd_skill 的 dispatch 流程（最常见）

1. `node $SCRIPT dispatch-prompt <name>` → 取所有字段
2. 校验 `validation.passed`
3. `node $SCRIPT mark-dispatch <name> --start`
4. **按 `dispatch-with-skill.md` 模板组装 prompt**：
   - 用 dispatch-prompt output 填充占位符
   - `<agent_definition>` 块注入 `validation.agent_file_content`
   - `<project_context>` / `<relevant_rules>` / `<git_diff>` / `<agent_history>` 注入 `context_pack.*.content`
   - **禁止**让 sub-agent 自己 Read agent_path
5. dispatch sub-agent
6. `node $SCRIPT mark-dispatch <name> --end`

## design-review 阶段

使用 `dispatch-design-review.md`（不走 dispatch-with-skill.md）：
- 对抗性审查协议（"Do Not Trust the Architect"）
- 强制先 Read proposal.md + design.md + tasks.md
- 输出结构化 JSON concerns + 写入 shared-state

## rework 派发

当 advance 返回 `next_action: "rework"`：
1. 按对应阶段模板（如 dispatch-with-skill.md）组装 prompt
2. **末尾追加** `dispatch-rework.md` 填充：
   - `{previous_phase}` / `{reason}` / `{next_role}` / `{rework_count}` / `{pua_debugging_required}` 来自 advance 返回值
3. rework sub-agent 必须先 `read-shared-state <name> --key concerns --status open`

## evaluate_concerns（暂停请 PM 评估）

当 advance 返回 `next_action: "evaluate_concerns"`（`needs_pm: true`）——**不 dispatch sub-agent**，而是暂停等待 PM。两个独立触发来源（OR 关系）：

1. **open P0 veto**：advance 读 `concerns.json` 发现 open P0（status !== 'resolved'）。无论 Worker 返回 `DONE_WITH_CONCERNS` 还是 code-review DONE，只要 open P0 > 0 就停。
2. **Worker 显式 `NEEDS_PM`**：Worker 主动声明下一步需 PM 拍板（歧义/取舍/显式请求）。不递增 `blocked_count`。

PM 处理后，通过 `resolve-concern` 标记 P0 resolved，或重新 `advance` 推进。`DONE_WITH_CONCERNS` + 无 open P0 不会触发本分支（自动推进，标 `[auto-promoted]`）。

## 自动化阶段（不 dispatch）

- **intake**：`run-automated` 命令，验证 title 非空 / criteria 至少 1 条 / 无冲突
- **smoke**：implement→test 阶段触发，内联执行 compile + lint（非独立 dispatch）

## 前置指导

advance 输出 `pre_guidance` 非空时（基于该角色最近 first_pass_rate < 0.5），追加到 prompt 末尾。

## per-phase 上下文裁剪（自动生效）

dispatch-prompt 调用 `assembleContextPack(changeName, intent, context_mode, phase)`，按 `context-pack.js:274-283` 的 `PHASE_CONTEXT_SKIP` 表自动跳过：

| 阶段 | 自动跳过的 context source |
|------|--------------------------|
| explore | git_diff、error_log、agent_history |
| propose | git_diff、error_log、agent_history |
| design-review | git_diff、error_log |
| implement | error_log |
| test | error_log、harness_rules |
| code-review | 无跳过 |
| debate | git_diff、error_log |
| archive | git_diff、error_log、spec_docs、agent_history |

`harness_rules` 按 `PHASE_RULES_ANCHORS`（context-pack.js:287-296）从 yaml 切片 2000 字符注入。

## Context Mode 自动升级

sub-agent 返回 NEEDS_CONTEXT → minimal → read_only → full。最多 2 次，超过 → escalate_to_pm。

## BLOCKED 处理

连续 3 次 BLOCKED → escalate_to_pm（advance.js:191-202 的 checkCircuitBreaker）。

## 制品校验门禁

sub-agent 完成 DONE 后，orchestrator 自动校验：
- explore：不做校验
- propose：proposal.md + design.md + tasks.md 必须存在
- implement：代码文件存在（git diff 非空）
- 校验失败 → 重 dispatch（最多 1 次）→ 仍失败 escalate_to_pm

## Backend 分流（codex / claude）— 通过 dispatch-agent wrapper

> **Phase 3a 强制入口**：主会话 dispatch sub-agent 必须通过 `node dispatch-agent.js <change>` wrapper。
> wrapper 内部完成 `dispatch-prompt → 渲染模板 → mark-dispatch --start → 按 backend.type 分流`。
> 主会话**禁止**直接调 `Agent` 工具或 `import CodexBackend`（advance 会校验 wrapper_invoked 字段）。

```text
# 主会话只调一行：
node .claude/skills/rd-auto/scripts/dispatch-agent.js <change-name>

# wrapper 内部：
dp = dispatch-prompt <change>           # 输出含 backend.type 字段
finalPrompt = renderTemplate("dispatch-with-skill.md" | "dispatch-without-skill.md", dp)
mark-dispatch <change> --start
# read-modify-write pipeline-state.json: dispatch_history 末尾追加 wrapper_invoked:true

if dp.backend.type === "codex":
    # 进程内 import CodexBackend，调 dispatchSubAgent（codex exec --json JSONL）
    rawResult = CodexBackend.dispatchSubAgent(role, finalPrompt, { skipBuildPrompt:true, phase, changeName, round })
    # wrapper 内部 mark-dispatch --end（透传 exit_status/summary/tokens_used）
    # wrapper 输出 { backend:"codex", action:"completed", result, tokens_used, log_file, wrapper_invoked:true }

elif dp.backend.type === "claude":
    # wrapper 输出 agent_args JSON，不实际执行 Agent
    # wrapper 输出 { backend:"claude", action:"invoke_agent_tool", agent_args, post_dispatch, wrapper_invoked:true }
    # 主会话读 agent_args 后用 Agent 工具二次执行，再调 post_dispatch.mark_dispatch_end_cmd

# 主会话：
result = wrapper output  # 已是统一 schema
advance <change> --exit-status $result.exit_status ...
```

### ClaudeBackend.dispatchSubAgent 的 PENDING 占位语义

`ClaudeBackend.dispatchSubAgent(...)` 永远返回 `{ exitStatus: "PENDING", message: "..." }`
而不真正执行——这是**文档化的"未实现"语义**，不是 bug。

Claude 模式下 dispatch 由主会话内置的 `Agent` 工具完成（sub-agent 是会话内的
sub-thread），backend 层无法直接发起。Phase 3a 起，主会话**必须**通过 dispatch-agent
wrapper 完成 dispatch：

- **Claude 模式**：wrapper 输出 `agent_args` JSON（含 subagent_type / prompt / description），
  主会话读后用 `Agent(subagent_type, prompt)` 二次执行，**禁止**直接绕过 wrapper 调 Agent
  （advance 会校验 `wrapper_invoked:true` 字段）
- **Codex 模式**：wrapper 进程内调 `CodexBackend.dispatchSubAgent(...)`，输出 normalizedResult
  给主会话，**禁止**主会话直接调 Agent 工具（会偏离 `HARNESS_BACKEND=codex` 的 PM 决策）

### Codex 模式的失败升级流程

codex dispatch 失败（auth / timeout / network / command_not_found / unparseable）
**禁止静默回退 claude**，必须 escalate_to_pm：

```text
if result.exit_status === "BLOCKED":
    # 1. raw output 已落盘（dispatchSubAgent 内部 _writeCodexLog 完成）
    # 2. 主会话 read-modify-write concerns.json（write-shared-state 无 --append，必须 RMS）
    existing = read-shared-state <change> --key concerns        # 拿到当前数组
    existing.push({
        "id": "CODEX-BLOCKED-<timestamp>",
        "severity": "P1",
        "status": "open",
        "type": "codex-dispatch-failed",
        "title": "codex dispatch BLOCKED: " + result.escalate_reason,
        "author": "<git_user>"
    })
    write-shared-state <change> --key concerns --json '<serialized existing>'  # 全量替换
    # 3. 提示 PM 决策（修复 codex 鉴权 / 显式切到 claude / abort change）
    halt with "codex dispatch BLOCKED — PM must decide"
```

例外：sub-agent 内部 BLOCKED（任务真做不下去，如 NEEDS_CONTEXT 2 次后），与
backend 切换无关，走标准 advance 路由（dispatch_history 累计 BLOCKED，3 次熔断）。

### Codex 模式 token 统计（Phase 3a 切 `codex exec --json`）

Phase 3a 起切换 codex CLI 协议到 JSONL 事件流（`codex exec --json`）。
`CodexBackend._parseOutput` 优先用 `_parseJsonlOutput` 解析事件流，从最后一个
`turn.completed` 事件精确提取 `usage.input_tokens + usage.output_tokens` 作为
`tokens_used`。`cached_input_tokens` / `reasoning_output_tokens` 记录到独立字段
（暂不入 tokens_used 求和，与现有 usage.jsonl claude 模式报表口径一致）。

JSONL 路径解析失败（无 `turn.completed` 事件，例如 codex 版本回归 plain text）
自动回退到旧 `_extractLastJsonBlock + _extractTokensUsed` plain text 路径，保留
向后兼容。

usage.jsonl 每条目加 `backend: "codex"` 字段，报表生成器区分 backend，
**不**与 claude 模式 token 求和。

详细配置见 `harness-rules.yaml → dispatch.timeout`（按 phase 的超时阈值表）。

### Codex 模式输出落盘审计

每次 codex dispatch 完成（无论成败），`CodexBackend.dispatchSubAgent` 把原始 stdout
+ 错误对象写入 `.harness/shared-state/<change>/codex-logs/<role>-<round>-<YYYYMMDDHHMMSS>.txt`。
文件名格式：`<role>-<round>-<timestamp>.txt`，例如 `architect-1-20260705193045.txt`。

文件结构：

```
# Codex dispatch log
# change: <change>
# role: <role>
# round: <round>
# timestamp: <YYYYMMDDHHMMSS>

## raw_output
<codex exec stdout 完整文本>

## error            # 仅失败时
{ error JSON }

## parsed           # 仅成功时
{ _parseOutput 后的结构化对象 }
```

用途：codex 没有 transcript jsonl，靠 codex-logs 补偿可观测性，便于事后审计与 debug。

### Fanout（team mode 并行）backend 分流

advance 返回 `next_action: "fanout_dispatch"` 时，主会话需要并行派发多个 sub-agent。按 `dispatch-prompt` 返回的 `backend.type` 分流：

| backend.type | 派发方式 | worktree 隔离 | 限制 |
|---|---|---|---|
| `claude` | 多个 `Agent(subagent_type=Developer, ...)`，每个 work_item 一个 worktree | ✅（每个 Agent 独立 worktree，由 advance 提供 worktree_path）| 无（full feature）|
| `codex` | `Promise.all(plan.agents.map(ag => backend.dispatchSubAgent(ag.role, finalPrompt, opts)))` | ❌ MVP 不支持（Phase 3）| work_item scope 必须严格不重叠 |

详细 codex 模式限制与主会话构造指南：见 `templates/dispatch-fanout.md → codex 模式 fanout（MVP 限制）`。

**通用原则**：
1. fanout 仍用 `dispatch-prompt` 获取 `backend` 字段（与单 dispatch 共用信号源）
2. 每个 work_item 独立 `mark-dispatch --end --work-item-id <wi>` 更新 state.team.work_items
3. 全部 status=reviewed 后调 `integrateWorktreeArtifacts`（codex 模式 MVP 跳过集成，因无 worktree）
