# daily-report

通过看板 MCP 查询任务、提交/查询日报。**不依赖 GitLab API**。

## 快速链接

| 想做什么 | 看哪里 |
|---------|--------|
| 触发技能、了解 5 种模式 | [SKILL.md](SKILL.md) |
| 用法示例 + MCP 工具对照 | [docs/usage.md](docs/usage.md) |
| 数据结构约束 | [schemas/taskboard-report.schema.json](schemas/taskboard-report.schema.json) |
| 单任务结构 | [schemas/taskboard-task.schema.json](schemas/taskboard-task.schema.json) |
| 渲染器 API | [scripts/render-report.js](scripts/render-report.js) |

> 本技能为旧版日报系统（基于 GitLab Markdown 文件）的替代方案。旧版已迁移至 `daily-report-legacy`，过渡期后删除。

## 模式速查

| 模式 | 触发词 |
|------|--------|
| §1 个人任务 | 我的任务 / my tasks |
| §2 看板全员任务 | 看板任务 / all tasks |
| §3 他人任务 | 查 X 的任务 |
| §4 提交日报 | 提交日报 / submit report |
| §5 查询日报 | 查询日报 / list reports |

> 切换当前看板：在菜单中选 `6` 或输入 `切换看板` / `用 X 看板`。首次进入任意模式时也会自动触发看板选择。

## MCP 工具对照

| 技能动作 | MCP 工具 |
|---------|---------|
| 列看板 | `mcp__taskboard__list-projects` |
| 读看板详情 | `mcp__taskboard__read-project` |
| 列任务 | `mcp__taskboard__list-tasks` |
| 列状态字典 | `mcp__taskboard__list-task-statuses` |
| 列成员字典 | `mcp__taskboard__list-project-members` |
| 提交日报 | `mcp__taskboard__create-project-report`（需传 `harnessVersion`，强制升级版本会被 409 拒收） |
| 列日报 | `mcp__taskboard__list-project-reports` |
| 读单条日报 | `mcp__taskboard__read-project-report` |

## 不在范围内

- git/AI 数据采集（v2 可扩展，与 daily-report 的 collect-git.js / collect-ai.js 合并）
- taskboard 任务创建/更新（仅查询 + 提交日报）
- 替换 daily-report 技能（共存策略）
