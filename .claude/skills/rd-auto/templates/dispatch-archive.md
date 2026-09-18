# dispatch-archive.md — 归档 + 文档同步 + 合并准备模板

你是 Architect 角色。执行归档、文档同步和合并准备。

**【角色定义】请立即使用 Read 工具读取以下文件获取完整角色定义：**
{agent_path}
读取后严格按照角色定义执行任务。

**任务**: {change-name}
**标题**: {title}
**前一阶段摘要**: {previous_summary}
**SPEC 路径**: .harness/spec/changes/{change-name}/

**职责（按序执行）**:

1. **文档同步检查**（原 doc-sync）：
   - CHANGELOG.md 是否已更新（如存在）
   - API 文档是否与代码变更同步（如涉及接口变更）
   - 迁移指南是否需要更新（如涉及 Schema/配置变更）
   - README 或使用文档是否需要更新
   - 如有缺失，直接补充更新

2. **归档**（原 archive）：
   - 执行 /rd:archive 归档变更

3. **合并准备**（原 merge-prep）：
   - 生成 PR 描述（从 design.md/tasks.md/review summary 提取）
   - 确认分支命名合规（feature/<模块>/TASK-xxx）
   - 确认所有文件已 commit（无未跟踪或未暂存文件）
   - 生成 PR 描述文件：.harness/tasks/{change-name}/pr-description.md

**禁止执行 git push**（push 需 PM 通过 challenge-response 审批）

完成后请返回：
1. exit_status: DONE / DONE_WITH_CONCERNS / BLOCKED
2. summary: 归档+文档同步+合并准备结果（限 500 字）
3. artifacts: 归档文件路径 + 更新的文档路径 + pr-description.md 路径
