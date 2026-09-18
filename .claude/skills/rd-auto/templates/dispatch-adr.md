# dispatch-adr.md — ADR 自动流程模板

检测到单向门决策后，主会话自动串联 Architect → Reviewer，无需 PM 介入。

## 1. Architect 起草 ADR

你是 Architect 角色。检测到本次变更包含单向门决策，需要创建 ADR。

**【角色定义】请立即使用 Read 工具读取以下文件获取完整角色定义：**
{agent_path}
读取后严格按照角色定义执行任务。

**任务**: {change-name}
**决策来源**: .harness/spec/changes/{change-name}/design.md 的 Decisions 章节
**模板路径**: .harness/templates/adr-template.md

**要求**:
1. 读取 adr-template.md 模板
2. 针对 design.md 中命中的单向门决策，填写完整 ADR
3. 写入 .harness/adr/ 目录，命名格式 NNNN-title-with-dashes.md
4. 编号从目录中已有最大编号 +1
5. 在 design.md 的对应 Decision 后追加引用：`> ADR: NNNN-title-with-dashes.md`

完成后请返回：
1. exit_status: DONE / BLOCKED
2. summary: ADR 创建情况（限 500 字）
3. artifacts: ADR 文件路径

## 2. Reviewer 评审 ADR

你是 Reviewer 角色。评审 ADR 的完整性和逻辑一致性。

**【角色定义】请立即使用 Read 工具读取以下文件获取完整角色定义：**
{agent_path}
读取后严格按照角色定义执行任务。

**ADR 路径**: {上一步 artifacts 中的路径}
**检查项**:
1. 必填章节是否齐全（title, status, date, decision_drivers, considered_options, decision_outcome, consequences）
2. considered_options 是否至少有 2 个备选方案
3. decision_outcome 是否明确无歧义
4. consequences 是否包含负面影响和缓解措施

完成后请返回：
1. exit_status: DONE / DONE_WITH_CONCERNS / BLOCKED
2. summary: ADR 评审结论（限 500 字）
3. score: 0-100

## 3. 评审结果处理

- score >= 80 → ADR 通过，通知 PM 审批结果，继续 pipeline
- score < 80 → 返工 Architect 修改 ADR（走 rework 流程，含 pua-debugging）

## 4. PM 通知（非阻断）

ADR 流程完成后，向 PM 汇报：`"{change-name} 检测到单向门决策，已自动完成 ADR（{ADR 路径}），评审得分 {score}"`
PM 有权否决任何 ADR，但不需要逐条审批。
