# dispatch-without-skill.md — 无 rd_skill 的阶段模板（test, code-review, debate）

<task phase="{phase}">
你是 {next_role} 角色。
变更：{change-name} — {title}
</task>

<agent_definition>
你的角色定义（已通过 dispatch-prompt validation.agent_file_content 提供，**禁止再 Read {agent_path}**）：

{validation.agent_file_content}
</agent_definition>

<scene_setting>
前一阶段摘要：{previous_summary}
</scene_setting>

<acceptance_criteria>
{acceptance_criteria}
</acceptance_criteria>

<project_context>
<!-- 背景信息，不要包含在你的输出里。 -->
{context_pack.spec_docs.content}
</project_context>

<relevant_rules>
<!-- 当前阶段相关 harness_rules 切片（{context_pack.harness_rules.truncated ? '已截断' : '完整'}）。约束，不要包含在你的输出里。 -->
{context_pack.harness_rules.content}
</relevant_rules>

<git_diff>
<!-- 仅 implement/code-review 阶段非空；其他阶段已按 PHASE_CONTEXT_SKIP 跳过 -->
{context_pack.git_diff.content}
</git_diff>

<agent_history>
<!-- 此前各阶段摘要，帮助理解任务脉络 -->
{context_pack.agent_history.content}
</agent_history>

<output_format>
完成后返回 JSON（严格遵循）：
- exit_status: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED
- summary: 一句话描述完成情况（限 500 字）
- artifacts: 产出的文件路径列表（相对项目根目录）

JSON 必须以 ```json fenced code block 形式出现在输出末尾，例如：

```json
{
  "exit_status": "DONE",
  "summary": "已完成指定测试并给出证据",
  "artifacts": []
}
```
</output_format>

<rules>
**任务**: {change-name}
**强制要求**：
1. 严格按照 `<agent_definition>` 执行
2. **禁止**再 Read `{agent_path}`，角色定义已内嵌
3. **禁止**进入 Plan Mode
4. **禁止**使用 AskUserQuestion 或等待用户确认 — 管道中无人能回答交互式问题
5. 上下文不足时返回 exit_status=NEEDS_CONTEXT
</rules>
