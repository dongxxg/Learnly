# dispatch-rework.md — 返工 dispatch 追加段

> **使用方式**：当 `advance` 输出 `next_action: "rework"` 时，主会话在 `dispatch-with-skill.md`（或对应阶段模板）填充后的 prompt **末尾追加**本段内容。
>
> **字段来源**：`advance` 返回值（rework 字段）。

---

<rework_notice>
**此阶段为返工（rework）**。前一阶段未通过门禁，你正在重新执行 `{current_phase}` 阶段。
**禁止沿用之前失败的方案**。先理解失败原因，再设计新方案。
</rework_notice>

<rework_context>
- **触发阶段**：`{previous_phase}`
- **触发原因**：{reason}
- **路由目标角色**：{next_role}
- **已返工次数**：{rework_count}（同一角色累计）
- **熔断阈值**：连续 2 次同角色返工触发 pua-debugging；总 blocked_count >= 3 触发 escalate_to_pm
</rework_context>

<mandatory_first_step>
**第一步必须执行**（在开始任何修复工作之前）：

```bash
node .claude/skills/rd-auto/scripts/orchestrator.js read-shared-state {change-name} --key concerns --status open
```

读取所有**未解决**的 P0/P1 concerns。这是你**必须**解决的问题清单。

如果 concerns.json 不存在或为空，但仍触发 rework（如 smoke 检查失败），按 rework_context.reason 中描述的问题修复。
</mandatory_first_step>

<fix_protocol>
对每一条 concern：
1. **定位**：根据 concern.location（如 "design.md §接口定义" / "tasks.md WI-3"）找到具体位置
2. **修复**：按 concern.suggested_revision 修复，但**保持质疑**——如果建议本身有问题，按你的判断修复并在 summary 中说明
3. **标记解决**：修复并自检后，立即调用：

```bash
node .claude/skills/rd-auto/scripts/orchestrator.js resolve-concern {change-name} --concern-id <C001>
```

4. **不允许批量解决**：每条 concern 单独验证、单独 resolve
</fix_protocol>

<completion_checklist>
返回 exit_status=DONE 前，确认：
- [ ] 所有 P0 concern 已解决（resolve-concern 调用成功）
- [ ] P1 concern 全部解决或 summary 中明确说明遗留原因
- [ ] 修复涉及的文件已通过本地 lint/build（如果适用）
- [ ] summary 中说明：修复了哪些 concern、改了哪些文件、为什么这次方案不会重蹈覆辙
</completion_checklist>

<pua_debugging_block>
{pua_debugging_required ?
'**pua-debugging 已触发**：调用 Skill(skill="pua-debugging") 激活失败恢复方法论。
按"先闻味道、再揪头发、照镜子"的顺序，**禁止直接动手改代码**。
你的失败已经不是偶然——之前的方案有结构性问题，必须先识别模式再修复。'
: '<!-- pua-debugging 未触发，但仍然禁止沿用之前失败的方案 -->'}
</pua_debugging_block>

<output_addition>
除 dispatch-with-skill.md 要求的 exit_status / summary / artifacts 外，**额外返回**：
- `concerns_resolved`: 本次解决的 concern id 列表，如 `["C001", "C003"]`
- `concerns_deferred`: 遗留未解决的 concern id + 原因，如 `[{"id": "C002", "reason": "需要外部接口确认"}]`
</output_addition>
