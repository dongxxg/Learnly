---
name: rd:auto
version: 1.0.0
description: 自动调度 AI 角色完成 Uni-AURI 开发全流程。用户提出搭建项目、开发功能、添加接口、修复代码或编写测试等需求时使用；系统自动串联 rd skill。
trigger: "/rd:auto"
---
# rd:auto — 自动调度循环

你是自动调度引擎的执行者。PM 通过自然语言描述需求，你将其翻译为 orchestrator 命令，驱动 AI 角色自动完成开发全流程。

## 核心原则

- **PM 只说人话**：不需要知道阶段名、CLI 参数、角色分派规则
- **自动推进**：从当前状态开始，连续 dispatch sub-agent 直到需要 PM 介入
- **状态持久化**：每次推进都写入 `.harness/tasks/{change-name}/pipeline-state.json`，不怕上下文压缩
- **不重复 rd 的功能**：制品管理交给 rd 命令，你只负责调度决策

## 引擎调用

```bash
SCRIPT="${HARNESS_ROOT:-.claude}/skills/rd-auto/scripts/orchestrator.js"

# 初始化新任务
node $SCRIPT init <change-name> --title "标题" --criteria "验收条件1,验收条件2" \
  [--flow-type <development|docs|hotfix|refactor|test-only|config-change|quick>] \
  [--intent-json '{"raw_input":"...","task_type":"...","confidence":0.85,"modules":[...],"complexity_hint":"M"}']

# 推进到下一阶段
node $SCRIPT advance <change-name> [--exit-status DONE] [--score 85] [--p0-count 0] [--summary "..."]

# 状态查询
node $SCRIPT status <change-name>
node $SCRIPT dashboard
node $SCRIPT complete <change-name>

# dispatch sub-agent
node $SCRIPT dispatch-prompt <change-name>     # 取 prompt 字段
node $SCRIPT mark-dispatch <change-name> --start|--end
```

## 意图解析（核心规则）

**task_type 关键词映射**（详细推断见 [references/intent-parsing.md](references/intent-parsing.md)）：


| PM 说的           | task_type     |
| --------------- | ------------- |
| "实现/开发/新增/添加功能" | development   |
| "写文档/ADR"       | docs          |
| "热修复/hotfix"    | hotfix        |
| "重构/拆分/合并模块"    | refactor      |
| "补测试/测试覆盖"      | test-only     |
| "改配置/CI配置"      | config-change |


**change-name 推导**：`"实现用户登录功能" → user-login`；简短、描述性、kebab-case。

**置信度阈值**：confidence &gt;= 0.7 直接执行；&lt; 0.7 向 PM 确认。

**多意图**：输入含 "同时" "另外" "还有" → 拆分独立 pipeline。

**特殊意图**：

- "继续/resume" + 名称 → dashboard 找任务 → 读 status 的 Checkpoint 行（advance 自动落盘的恢复点，含 next_action/next_rd_skill，无需重跑推断）→ 按 checkpoint 执行或 advance
- "评审/review" + 名称 → set-phase code-review
- "测试/test" + 名称 → set-phase test
- "归档/archive" + 名称 → set-phase archive
- 无参数 → dashboard

## 自动调度循环

```text
1. 解析意图 → confidence >= 0.7 直接执行
   1.5. recommend-mode：team 模式向 PM 建议
2. orchestrator advance
3. next_action 分支处理：
   - automated → run-automated（intake，禁止 dispatch）
   - dispatch + next_rd_skill → dispatch-prompt → mark-dispatch --start
     → 渲染模板得 finalPrompt → 按 backend.type 分流（见下文「主会话 backend 分流」）
     → mark-dispatch --end
   - dispatch no rd_skill → 同上，不传 rd_skill
   - rework → 对应阶段模板 + 末尾追加 dispatch-rework.md
   - wait_for_pm / needs_pm → 暂停汇报
   - escalate_to_pm → 熔断报告
   - fanout_dispatch → 主会话调 `node fanout-dispatch-agent.js <change>` → 拿 `results[]` → 逐条调 `advance --work-item-id ... --worktree-path ...`
4. sub-agent 完成 → 收集 exit_status / summary / score / artifacts
5. 制品校验门禁（强制）→ 失败重 dispatch（最多1次）→ 仍失败 escalate_to_pm
6. advance 传递结果
7. 循环
```

## 主会话 backend 分流（codex / qoder / claude / codebuddy / zcode）— 必须通过 dispatch-agent wrapper

> **Phase 3a 硬条款**：主会话 dispatch sub-agent **必须**通过 `node dispatch-agent.js <change>` wrapper；**禁止**绕过 wrapper 直接调 Agent 工具或 import backend。`advance` 命令会校验 `dispatch_history` 末尾的 `wrapper_invoked:true` 字段，缺失时拒绝推进。

`dispatch-prompt` 输出的 `backend.type` 字段（值取 `getBackendInfo()`）是主会话
dispatch 路径的唯一信号源。wrapper 内部按 `dp.backend.type` 自动分流：

```text
# 主会话只调一行命令：
node ${HARNESS_ROOT:-.claude}/skills/rd-auto/scripts/dispatch-agent.js <change-name>
# wrapper 内部：dispatch-prompt → 渲染模板 → mark-dispatch --start → 分流 → 输出统一 schema
```

### wrapper 输出 schema（顶层 8 字段）


| 字段                | 类型                                                                    | codex / qoder 路径                  | claude / codebuddy / zcode 路径            |
| ----------------- | --------------------------------------------------------------------- | --------------------------------- | ---------------------------------------- |
| `backend`         | `"codex" | "qoder" | "claude" | "codebuddy" | "zcode"`                | 对应 headless backend              | 对应交互 backend                           |
| `action`          | `"completed" | "invoke_agent_tool" | "no_dispatch" | "wrapper_error"` | `"completed"`                     | `"invoke_agent_tool"`                    |
| `result`          | object | undefined                                                    | normalizedResult（snake_case）      | undefined                                |
| `agent_args`      | object | undefined                                                    | undefined                         | `{ subagent_type, prompt, description }` |
| `tokens_used`     | number | null                                                         | input + output 求和（来自 JSONL usage） | null                                     |
| `log_file`        | string | undefined                                                    | `<backend>-logs` 路径               | undefined                                |
| `post_dispatch`   | object | undefined                                                    | undefined                         | `{ mark_dispatch_end_cmd }`              |
| `wrapper_invoked` | `true`                                                                | true                              | true（同时写入 dispatch_history）              |


### headless 路径（HARNESS_BACKEND=codex / qoder）

```json
{
  "backend": "codex",
  "action": "completed",
  "result": {
    "exit_status": "DONE",
    "summary": "已实现 feature X",
    "artifacts": ["src/feature.js"],
    "score": 85
  },
  "tokens_used": 9376,
  "log_file": ".harness/shared-state/<change>/codex-logs/developer-1-20260705120000.txt",
  "wrapper_invoked": true
}
```

Qoder 返回相同 schema，仅 `backend` 为 `qoder`，日志目录为 `qoder-logs`；官方未公布稳定 token 拆分 schema，因此只记录 CLI 明确返回的 total，其他 token 字段保持 `null`。

主会话读 `result.exit_status` 透传到 `advance`。headless 路径 wrapper 内部已调
`mark-dispatch --end`，主会话**无需**再调。

### claude / codebuddy / zcode 路径

```json
{
  "backend": "claude",
  "action": "invoke_agent_tool",
  "agent_args": {
    "subagent_type": "Developer",
    "prompt": "<finalPrompt 已渲染>",
    "description": "<change>/<phase>/<role>"
  },
  "post_dispatch": {
    "mark_dispatch_end_cmd": "node orchestrator.js mark-dispatch <change> --end --exit-status <STATUS> --summary <SUMMARY> --backend claude"
  },
  "wrapper_invoked": true
}
```

主会话读 `agent_args` 字段后用内置 `Agent` 工具二次执行（node 脚本无法直接调内置
Agent），Agent 返回后调 `post_dispatch.mark_dispatch_end_cmd` 透传 exit_status /
summary / score，再调 `advance`。

ZCode 官方只文档化桌面 Agent 与内置 Agent 工具，没有公开 headless CLI，因此必须走此交互路径；其临时 Hook transcript 也不能作为稳定 token 来源。

**关键约定**：

- wrapper 内部完成 `dispatch-prompt → 渲染 → mark-dispatch --start → 分流 → mark-dispatch --end`（codex/qoder 路径）
- claude/codebuddy/zcode 路径 wrapper 不调 `mark-dispatch --end`，留给主会话二次执行后调
- `wrapper_invoked: true` 字段由 wrapper 写入 `pipeline-state.json` 的 `dispatch_history` 末尾
- `changeName + round` 用于把原始 output 落盘到 `.harness/shared-state/<change>/<backend>-logs/`
- shared-state 目录由 archive 流程清理，cmdComplete 不再删除

详细伪代码、失败升级流程、token 处理：见 [references/dispatch-flow.md](references/dispatch-flow.md)。

**dispatch 模板选择、字段填充、per-phase 裁剪**：见 [references/dispatch-flow.md](references/dispatch-flow.md)。

**模板列表**（位于 `${HARNESS_ROOT:-.claude}/skills/rd-auto/templates/`）：

- `dispatch-with-skill.md` — 有 rd_skill（explore/propose/implement/archive）
- `dispatch-without-skill.md` — 无 rd_skill（test/code-review/debate）
- `dispatch-design-review.md` — 对抗性设计审查
- `dispatch-rework.md` — 返工追加段
- `dispatch-fanout.md` — team mode 并行派发
- `dispatch-archive.md` — 归档
- `dispatch-adr.md` — ADR 流程

## 循环终止条件

- escalate_to_pm → 熔断，报告 PM
- open P0 concern → 停，`needs_pm`（PM 必须评估，无论 Worker 返回哪个 exit_status）
- 非 P0 concern（P1/P2/观察性）→ **自动推进**（标记 `[auto-promoted: non-P0 concerns]`，由 code-review scoring 兜底）
- NEEDS_PM（Worker 显式声明）→ 停，`needs_pm`（不递增熔断计数）
- NEEDS_CONTEXT 两次 → 暂停请 PM
- PM 中断 → 暂停

> 路由判据是 `concerns.json` 的 open P0 数量，不再依赖 summary 文本关键词。
> `DONE_WITH_CONCERNS` + 无 open P0 = 自动推进；`DONE_WITH_CONCERNS` + 有 open P0 = 停。

## Shared-State（跨角色状态）

`.harness/shared-state/<change>/` 跨角色共享：

- `concerns.json`：Reviewer 写入 P0/P1，Developer 返工时读取
- P0 veto：code-review 检测 open P0 → rework
- Developer 解决后 `resolve-concern --concern-id C001`

详细协议见 [references/shared-state.md](references/shared-state.md)。

## SPEC 制品路径

每个 change 的 SPEC 制品（exploration.md / proposal.md / design.md / tasks.md 等）放在：

- **开发中**：`.harness/spec/changes/<change-name>/`
- **归档后**：`.harness/spec/archive/<YYYY-MM-DD>-<change-name>/`（由 rd-archive 自动迁移，不要手动移动）
- **长期规范**：`.harness/spec/specs/`（跨 change 的规范集合，与单次变更无关）

⚠️ 不要放到 `.harness/tasks/`（那是 pipeline-state.json 运行时位置）；也不要自创 `.harness/spec/<module>/` 等子目录。

## References 索引（按需 Read，避免主 SKILL.md 膨胀）

- [references/intent-parsing.md](references/intent-parsing.md) — task_type / Flow Type / Context Mode 详细推断表、置信度、多意图、特殊意图、change-name 推导
- [references/dispatch-flow.md](references/dispatch-flow.md) — dispatch-prompt 字段说明、模板选择、字段填充、per-phase 裁剪、Context Mode 升级、BLOCKED 处理、制品校验门禁
- [references/adr-and-quick.md](references/adr-and-quick.md) — ADR 触发条件、Quick Dispatch 4 阶段流程
- [references/shared-state.md](references/shared-state.md) — concerns.json 结构、P0 Veto 机制、与 rd CLI 边界
- [references/example-workflow.md](references/example-workflow.md) — 完整开发流程示例（PM 输入 → archive）
- [references/cost-optimization.md](references/cost-optimization.md) — per-phase 裁剪、模板结构化、shared-state、高 token change 识别
