# Example Workflow — 完整开发流程示例

> 主会话首次理解 rd-auto 行为时 Read 本文件。展示从 PM 输入到 archive 的完整对话。

## 示例：实现用户登录功能

```
PM: 实现用户登录功能

主会话（自动调度循环）:
  1. 意图解析:
     - task_type = development
     - change_name = user-login
     - confidence = 0.95 (>= 0.7，直接执行)
     - context_mode = full (实现类)

  2. init → advance → intake(automated 验证) → advance

  3. explore 阶段:
     - dispatch-prompt user-login → role=architect, phase=explore, context_pack=...
     - 按 dispatch-with-skill.md 组装 prompt（含 <agent_definition> + <project_context>）
     - dispatch Architect sub-agent，sub-agent 调用 Skill("rd:explore")
     - sub-agent 返回 DONE → advance

  4. propose 阶段:
     - dispatch Architect sub-agent，调用 Skill("rd:propose")
     - 产出 proposal.md + design.md + tasks.md + specs/
     - 制品校验通过 → 检查 ADR 触发条件 → 命中"跨模块接口变更" → 触发 ADR
     - sub-agent 返回 DONE → advance

  5. design-review 阶段（complexity >= L 时触发）:
     - 按 dispatch-design-review.md 组装 prompt（对抗性审查）
     - dispatch Developer sub-agent
     - sub-agent Read proposal.md + design.md + tasks.md
     - 输出 JSON concerns + write-shared-state
     - verdict=APPROVED → advance；verdict=REWORK_NEEDED → 回 propose

  6. implement 阶段:
     - 按 dispatch-with-skill.md 组装 prompt
     - dispatch Developer sub-agent，调用 Skill("rd:apply")
     - 写代码 + 测试 → DONE → advance

  7. test 阶段（implement→test 自动 smoke check）:
     - smoke PASS → 继续
     - smoke FAIL → 回 implement（rework）
     - dispatch Tester sub-agent → DONE → advance

  8. code-review 阶段:
     - dispatch Reviewer sub-agent
     - 输出 score=92, P0=0
     - advance 检查 concerns.json: P0=0, score>=90 → archive（debate 跳过）

  9. archive 阶段:
     - dispatch Architect sub-agent，调用 Skill("rd:archive")
     - 同步 spec → complete
```

## 关键节点说明

| 节点 | 触发条件 | 行为 |
|------|---------|------|
| design-review 跳过 | complexity in {S, M} 且非 refactor | markSkippedPhase → 直接 implement |
| ADR 触发 | propose 后命中 trigger_conditions | dispatch-adr.md 流程 |
| debate 触发 | code-review score in [75, 80) | dispatch Debate sub-agent |
| rework 触发 | code-review score < 75 或 P0 > 0 | 路由到 developer/tester，追加 dispatch-rework.md |
| escalate_to_pm | blocked_count >= 3 或 NEEDS_CONTEXT 两次 | 熔断，请求 PM 介入 |
