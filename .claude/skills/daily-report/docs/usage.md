# daily-report 用法手册

## 前置条件

- taskboard MCP server 已在会话中可用（看到 `mcp__taskboard__*` 工具）
- `mcp__taskboard__whoami` 返回的 token scope 为 readwrite（只读无法提交日报）

## 首次使用

1. 浏览器打开 http://192.168.5.115
2. 用户名是你的邮箱地址（如 `zhangsan@unitechs.com`），默认密码 `12345678`
3. 登录后，点击左下角月牙图标右侧的齿轮图标
4. 在设置中创建个人访问令牌（PAT），保存备用

> PAT 用于配置 MCP server 连接，详见项目 `.mcp.json` 中的 `Authorization` 配置。

## 看板选择

第一次进入任意模式时，技能会让你选 taskboard 看板：

1. 调用 `mcp__taskboard__list-projects` 获取全部可访问看板
2. `AskUserQuestion` 弹出选择菜单（每页 4 项，可翻页）
3. 选定后写入 `daily-report-tmp/.active-project`（单行 `projectId|projectName`）

之后所有模式自动复用此看板。切换只需说"切换看板"或"用 X 看板"。

## 五个模式

### §1 个人任务

> 关键词：`我的任务` / `my tasks`

```javascript
await mcp__taskboard__list-tasks({
  projectId: '<active>',
  assignedToMe: true,
  verbose: true
});
```

输出：Markdown 表格，列含 Code / 标题 / 状态 / 优先级 / 截止。

### §2 看板全员任务

> 关键词：`看板任务` / `全员任务`

```javascript
await mcp__taskboard__list-tasks({projectId: '<active>', verbose: true});
```

输出：按负责人分组的 Markdown 表格。

### §3 他人任务

> 关键词：`查 X 的任务` / `X 在做什么`

```javascript
const members = await mcp__taskboard__list-project-members({projectId});
const userId = members.find(m => m.name.includes('X')).id;
const all = await mcp__taskboard__list-tasks({projectId, verbose: true});
const filtered = all.filter(t => t.assigneeId === userId);
```

### §4 提交日报

> 关键词：`提交日报` / `submit report`

完整步骤见 [SKILL.md §4](../SKILL.md)。核心流程：

```
0. Uni-AURI 版本门禁：check-harness-version.js（强制升级未完成时阻断提交，无豁免）
1. 看板选择（§0a）
2. MCP 拉数据：list-tasks + list-task-statuses + list-project-members + read-project
3. 合成 tasks.json，落盘 daily-report-tmp/<date>-<user>.tasks.json
4. render-report.js 渲染 MD + JSON（schema 校验）
5. curl POST /api/reports 提交（带 harnessVersion 字段，见 SKILL.md §4 Step 8）
6. 回写 submitted_report_id（可选）
```

**关键约束**：
- 调用 `render-report.js` 时**禁止** `2>&1`，三流必须独立
- `jsonData` 字段必须是 JSON.stringify 后的字符串
- 幂等：同 `(projectId, author, reportDate)` 重提会覆盖
- **版本门禁**：提交必须带 `harnessVersion`（取 `.harness/.harness-version` 首行）；服务端对强制升级版本返回 409 拒收，需 `/upgrade-harness` 后重试

### §5 查询日报

> 关键词：`查询日报` / `查日报`

```javascript
// 全量
await mcp__taskboard__list-project-reports({projectId, limit: 20});

// 按 author 过滤
await mcp__taskboard__list-project-reports({projectId, author: 'wangzk', limit: 20});

// 单条详情（含完整 markdown + json_data）
await mcp__taskboard__read-project-report({projectId, reportId});
```

## 渲染器 CLI

```bash
node .claude/skills/daily-report/scripts/render-report.js \
  --date YYYY-MM-DD \
  --user <git_username> \
  --project '{"id":"...","name":"...","slug":"..."}' \  # 内联 JSON，或 @file 读取
  --tasks <tasks.json> \                                  # @file 或内联 JSON
  --repo <repo_name> \                                    # 可选
  --output <output.md> \
  --json-output <output.json>
```

成功：stdout 输出一行 JSON 摘要（`{ok, output, json_output, stats}`），写入两个文件。
失败：stderr 输出一行错误，不写文件，非零退出码。

## Schema 要点

**taskboard-report**（顶层，必填）：
- `date` (YYYY-MM-DD)
- `git_username` (string, ≥1)
- `project` ({id, name, slug?})
- `tasks` (数组，可为空)

可选：`repo` / `stats` / `submitted_report_id` / `submitted_at`

**taskboard-task**（数组元素，必填）：
- `id` / `title`
- `status` ({id, name, color?, is_terminal?, is_initial?})

可选：`code` / `priority` (low|medium|high) / `assignee` ({id, name, email?} | null) / `due_date` (YYYY-MM-DD | null) / `branch_id`

## 故障排查

| 症状 | 排查 |
|------|------|
| `whoami` 报未授权 | taskboard MCP server 未配置或令牌过期；联系管理员 |
| `create-project-report` 报权限 | token scope 是 readonly；需 readwrite |
| `render-report.js: schema validation failed` | tasks.json 字段缺失；按错误信息补 `id` / `title` / `status.id` / `status.name` |
| MD 文件含 stack trace | 调用时误用 `2>&1`；改为三流独立，stderr 单独捕获 |
| 重提日报没生效 | 同 (projectId, author, reportDate) 才幂等；检查 author 拼写 |
