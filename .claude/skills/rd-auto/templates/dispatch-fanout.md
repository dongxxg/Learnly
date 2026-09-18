# dispatch-fanout.md — Fanout 并行派发模板（team mode）

> 阶段语义：implement 阶段并行派发，每个 sub-agent 在独立 worktree 中实现一个 work item。
> **主会话使用此模板组装 fanout sub-agent prompt**。
> 占位符 `{xxx}` 由主会话从 dispatch-prompt output 和 advance fanout_dispatch 返回值填充。
> **模板竖线下方（`---`）的内容才进 sub-agent prompt；底部"主会话构造指南"仅供主会话参考，不进 prompt**。

---

<task phase="implement">
你是 {role_label} 角色。在独立 worktree 中{action_description}。
变更：{change-name} — {title}
</task>

<agent_definition>
你的角色定义（已通过 dispatch-prompt validation.agent_file_content 提供，**禁止再 Read {agent_path}**）：

{validation.agent_file_content}
</agent_definition>

<scene_setting>
前一阶段摘要：{previous_summary}
SPEC 路径：.harness/spec/changes/{change-name}/
</scene_setting>

<acceptance_criteria>
{acceptance_criteria}
</acceptance_criteria>

<your_work_item>
**Work Item**: {agent.work_item_id}: {agent.description}
**Role**: {role_label}
**Scope**: 仅处理 tasks.md 中与本 work_item 对应的 `##` 分组下的任务。
**Worktree**: 你在独立 worktree `{agent.worktree_path}` 中工作。
{role_specific_instructions}
</your_work_item>

<siblings>
已完成或进行中的兄弟 work_items（**仅元数据，需要看具体产出时自行 Read artifact 路径**）：
{siblings_summary}

注意：兄弟 work_item 的 artifact 路径未在此列出，避免上下文膨胀。如需查看：
1. 先 Read `.harness/spec/changes/{change-name}/tasks.md` 找到兄弟 work_item 的分组编号
2. 按分组编号在 worktree 或主仓中定位产物文件
3. 仅在确实需要协调接口时才 Read（如不同 work_item 之间有共享接口）
</siblings>

<project_context>
<!-- 已按 implement phase 裁剪（跳过 error_log） -->
{context_pack.spec_docs.content}
</project_context>

<relevant_rules>
{context_pack.harness_rules.content}
</relevant_rules>

<git_diff>
<!-- 当前主仓的 git diff（不含各 worktree） -->
{context_pack.git_diff.content}
</git_diff>

<mandatory_first_step>
开始工作前，**必须先 Read**：
1. `.harness/spec/changes/{change-name}/design.md` — 理解整体设计
2. `.harness/spec/changes/{change-name}/tasks.md` — 找到你的 work_item 对应的分组编号和具体任务

**禁止**凭 acceptance_criteria 和 work_item title 直接动手——你必须先看到 tasks.md 中你的分组详情。
</mandatory_first_step>

<output_format>
完成后返回 JSON（严格遵循）：
- exit_status: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED
- summary: 限 500 字（developer: 说明实现的内容 + 测试结果；reviewer: 评审结论 + 评分依据）
- artifacts: 文件路径列表（**相对项目根目录**，不含 worktree 前缀）（developer 必填，reviewer 空数组）
- worktree_path: 当前 worktree 的绝对路径（主会话据此集成产物）
- score: 0-100 整数（reviewer 必填，developer 可选）
- p0_count: P0 问题数量（reviewer 必填，developer 可选）
- concerns: 可选，结构化问题列表（含 level/type/title 字段）（reviewer 评审产出）

JSON 必须以 ```json fenced code block 形式出现在输出末尾，例如：

```json
{
  "exit_status": "DONE",
  "summary": "已实现 feature X，含 5 个测试",
  "artifacts": ["src/feature.js", "tests/test_feature.py"],
  "worktree_path": "/abs/path/to/worktree"
}
```

reviewer 额外要求：评审完成后还须调用 `orchestrator.js write-shared-state <change-name> --key concerns` 落盘 concerns.json（见 reviewer.md 产出契约）。`<output_format>` 的 score/p0_count/concerns 与 concerns.json 落盘不冲突——前者是 dispatch result JSON（normalizeDispatchResult 解析），后者是 shared-state 持久化（daily-report 读取）。
</output_format>

<rules>
**强制要求**：
1. 必须先 Read mandatory_first_step 列出的文件
2. **禁止**修改 scope 外的文件（reviewer: 禁止修改任何实现文件）
3. **禁止**进入 Plan Mode
4. **禁止**使用 AskUserQuestion — 管道中无人能回答
5. **禁止** Read {agent_path}，角色定义已在 `<agent_definition>` 提供
6. **禁止** Read 其他兄弟 worktree 的内容（隔离原则）——只能基于共享的 spec/changes/ 文件协调
7. 遇到兄弟 work_item 接口冲突且无法独立解决时 → exit_status=BLOCKED，summary 说明冲突
8. 必须通过 Skill(skill="rd:apply") 执行实施（如有 rd_skill）
</rules>

---

## 主会话构造 fanout prompt 的指南

> **以下内容不进 sub-agent prompt**，仅供主会话在组装 dispatch-prompt 时参考。

### `{siblings_summary}` 字段填充规则

为避免 fanout prompt 等比例膨胀，**仅注入兄弟 work_item 的 id + title**，不注入 artifact_paths 详情：

```
- WI-1: 用户登录基础流程 [status: reviewed]
- WI-2: 权限校验中间件 [status: implemented, in review]
- WI-3: 登录失败重试限制 [status: in_progress]
```

主会话从 `state.team.work_items` 读取，每条仅取 `id` / `title` / `status`，**忽略 artifact_paths**。

### 反模式（主会话组装 prompt 时避免）

| 反模式 | 问题 | 修正 |
|--------|------|------|
| 注入兄弟 artifact 完整内容 | prompt 等比例膨胀（N 个兄弟 × artifact size） | 仅注入 id+title，sub-agent 按需 Read |
| "修复所有测试"作为 work_item 描述 | scope 太大 | "修复 X.test.ts 中的 3 个失败用例" |
| 无 worktree_path | 主会话无法集成产物 | 必须从 fanout_dispatch 返回值取 worktree_path |
| 让 fanout agent 看到其他 worktree | 破坏隔离 | 仅共享 spec/changes/，不共享 worktree |

### Worktree 集成

主会话在所有 work_item status=reviewed 后调用 `integrateWorktreeArtifacts`（`fanout.js:74-127`）：
- 复制每个 worktree 的 artifact 到主仓
- 重叠路径 last-writer-wins + warning
- 路径遍历防护已内置

### codex 模式 fanout（Phase 3c: worktree 隔离）

Phase 3c 实现了 codex 模式 fanout 的 git worktree 隔离，替代了 MVP 阶段的"仅并行 dispatch，不做 worktree 隔离"方案。

**流程**：

```text
fanout_dispatch → 主会话调 node fanout-dispatch-agent.js <change>
    → 加载 pipeline-state（校验 team mode + implement phase）
    → fanoutDispatchPlan(state) 获取 agents[]
    → createWorktrees(changeName, agents) 为每个 work_item 创建独立 git worktree
        （路径：.harness/.worktrees/<change>/<wi-id>/，detached HEAD）
    → 渲染 dispatch-fanout.md 模板为每个 agent 生成 finalPrompt
    → Promise.all(dispatchSubAgent({cwd=worktree})) 并行 dispatch
    → normalizeDispatchResult 归一化每个结果
    → stdout 输出 JSON: {backend, action:"fanout_completed", results[], wrapper_invoked}
    → 主会话拿 results[] → 逐条调 advance --work-item-id ... --worktree-path ...
    → 主会话在所有 work_item reviewed 后调用 integrateWorktreeArtifacts（复制产物到主仓）
    → teamAdvance allDone 路径调用 cleanupWorktrees（git worktree remove --force）
```

**关键约定**：
- `fanout-dispatch-agent.js` 是独立 wrapper，不污染单 dispatch 路径（`dispatch-agent.js`）
- worktree 创建使用 `git worktree add --detach <path> HEAD`，在 `.harness/.worktrees/<change>/<wi-id>/`
- 代码 dispatch 使用 `opts.cwd`，通过 `spawn('codex', ..., { cwd: worktree_path })` 传递
- 单 worktree 创建失败不阻塞其他（该 work_item 标记 `error`）
- Sandbox 约束：codex `workspace-write` 不限制到 cwd（MVP 接受，Phase 4 考虑 post-dispatch 路径校验）
- `integrateWorktreeArtifacts` 零改动（从 `wi.worktree_path` 复制产物到主仓，已通用）
- `cleanupWorktrees` 只清理 `status === 'reviewed'` 的 worktree，单清理失败不阻塞整体

**与 MVP 阶段的差异**：

| 方面 | MVP（Phase 3b） | Phase 3c |
|------|-----------------|----------|
| Worktree 隔离 | 无（同目录并行写） | git worktree 独立隔离 |
| 产物安全 | scope 必须严格不重叠 | 天然隔离，scope 允许重叠 |
| 清理 | 手动 | 自动（allDone 后 cleanupWorktrees） |
| Dispatch 入口 | 主会话内联 `Promise.all(dispatchSubAgent(...))` | `fanout-dispatch-agent.js` wrapper |
| 集成 | 无（产物已在主仓） | `integrateWorktreeArtifacts` 自动复制 |
