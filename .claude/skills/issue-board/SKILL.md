---
name: issue-board
version: 1.0.0
description: Use when viewing AI-discovered CI issues on a kanban board, assigning fixes, dispatching issues, or querying group-level milestones across projects. Triggers: 问题看板, issue board, 查看问题, AI问题, CI问题, /issue-board, milestone, 战役, group milestone, 跨项目 milestone, 630 战役
---

# Issue Board AI 问题看板管理技能

## Overview

从 GitLab 拉取 CI 中 AI 发现的问题，在本地展示看板、分派修复、指派人员。

## When to Use

- 需要查看 CI 流水线中 AI 检测到的代码质量问题
- 需要将问题分派给团队成员修复
- 触发词：问题看板, issue board, 查看问题, AI问题, /issue-board

## When NOT to Use

- 需要管理任务 → 使用 GitLab Issue（`/issue-board` skill）
- 需要 CI/CD 流水线操作 → 使用 `devops` skill

## Common Mistakes

| 错误 | 正确做法 |
|------|---------|
| 混淆问题看板和个人任务看板 | 本 skill 只管 CI AI 发现的问题，不是任务看板 |
| 不分派问题就关闭 | 每个问题必须有明确的责任人和状态 |
| 忽略低优先级问题 | 低优先级也应记录，定期回顾 |

## 触发词
- "看板"
- "issue board"
- "/issue-board"
- "查看问题"
- "AI问题"
- "修复 !3"（直接修复指定 Issue）
- "指派 !3 张三"

## 技能描述
从 GitLab Issues 中拉取 CI AI 团队自动创建的问题，格式化展示看板。PM 可在看板上分拣问题、指派给本地 AI 团队修复、指派给团队成员，实现 CI → 本地 CC 的信息回传闭环。

## 前置条件

- 已配置 GitLab Token（`GITLAB_TOKEN` 环境变量或 `.gitlab-config` 文件）
- 脚本路径：`${HARNESS_ROOT:-.claude}/skills/issue-board/scripts/gitlab-issue.sh`
- `API_URL` 和 `PROJECT_ID` 自动从 `git remote origin` 推导，无需手动配置

### 凭证配置

只需配置 `GITLAB_TOKEN`，其余参数自动从 git remote 推导。

优先级：环境变量 > `.gitlab-config` 文件 > CI 环境变量 > 自动推导

**环境变量方式**（推荐）：

```bash
export GITLAB_TOKEN="glpat-xxxxxxxxxxxx"
# GITLAB_API_URL 和 GITLAB_PROJECT_ID 自动从 git remote 推导
```

**`.gitlab-config` 文件方式**（放在项目根目录，**加入 .gitignore**）：

```
gitlab_token=glpat-xxxxxxxxxxxx
# gitlab_api_url 和 gitlab_project_id 可省略，自动从 git remote 推导
# 可选：gitlab_group=<group_path>，作为 milestone 命令的默认 group_path
#   命令行直接传 milestone <group_path> ... 会覆盖此值
```

> **安全提示**：`.gitlab-config` 包含敏感信息，必须加入 `.gitignore`。

## 执行步骤

### 1. 环境检测

```bash
# 验证凭证是否可用
bash ${HARNESS_ROOT:-.claude}/skills/issue-board/scripts/gitlab-issue.sh list --format json 2>/dev/null | head -c 100
```

如果凭证缺失，提示 PM 配置：
```
⚠️ GitLab Token 未配置

请选择配置方式：
1. 环境变量（推荐）：
   export GITLAB_TOKEN="your-token"
   # API 地址和项目 ID 自动从 git remote 推导

2. 项目配置文件：创建 .gitlab-config（已自动加入 .gitignore）
   gitlab_token=your-token
```

### 2. 拉取看板

```bash
# 获取所有开放 AI Issue
bash ${HARNESS_ROOT:-.claude}/skills/issue-board/scripts/gitlab-issue.sh list

# 按严重级别过滤
bash ${HARNESS_ROOT:-.claude}/skills/issue-board/scripts/gitlab-issue.sh list --severity P0
bash ${HARNESS_ROOT:-.claude}/skills/issue-board/scripts/gitlab-issue.sh list --severity P1
bash ${HARNESS_ROOT:-.claude}/skills/issue-board/scripts/gitlab-issue.sh list --severity P2

# 按维度过滤
bash ${HARNESS_ROOT:-.claude}/skills/issue-board/scripts/gitlab-issue.sh list --dimension security
bash ${HARNESS_ROOT:-.claude}/skills/issue-board/scripts/gitlab-issue.sh list --dimension code

# 获取单个 Issue 详情
bash ${HARNESS_ROOT:-.claude}/skills/issue-board/scripts/gitlab-issue.sh get <iid>
```

### 2.5 查询 Group Milestone（跨项目战役看板）

查任意 GitLab group 的跨项目 milestone（如「630 战役」这类散落在多 project 的战役）。这是跨仓库进度跟踪的核心入口。

```bash
bash ${HARNESS_ROOT:-.claude}/skills/issue-board/scripts/gitlab-issue.sh milestone <group_path> <milestone_iid> [--state opened|closed|all] [--format json|table]
```

- `<group_path>`：group 完整路径（支持嵌套，如 `UniData`、`UniData/backend`）。
- `<milestone_iid>`：milestone 在 URL 里的 **iid**（如 `.../milestones/2` 的 `2`），不是内部 API id。脚本自动转换。
- `--state`：默认 `opened`。`all` 看全部含已关闭。
- `--format`：默认 `json`（milestone 主消费场景是跨项目渲染，JSON 是主契约）。`table` 按项目分组快速查看。

示例：

```bash
# UniData group 的 630 战役 milestone（iid=2，预期 ~138 项）
bash ${HARNESS_ROOT:-.claude}/skills/issue-board/scripts/gitlab-issue.sh milestone UniData 2

# 查已关闭项
bash ${HARNESS_ROOT:-.claude}/skills/issue-board/scripts/gitlab-issue.sh milestone UniData 2 --state closed

# 嵌套 group + table 快速查看
bash ${HARNESS_ROOT:-.claude}/skills/issue-board/scripts/gitlab-issue.sh milestone UniData/backend 5 --format table
```

**JSON 输出 schema**（脚本做规范化，非原样透传，保证跨项目可定位）：

```json
{
  "milestone": {
    "id": 8, "iid": 2, "title": "630 战役 [UniData]", "description": "...",
    "state": "active", "due_date": "2026-06-30", "start_date": "2026-06-01",
    "group": { "id": 18, "full_path": "UniData" }
  },
  "summary": {
    "total": 138, "opened": 129, "closed": 9,
    "by_project": [ {"project_id": 110, "path": "UniData/630-campaign", "count": 138} ]
  },
  "issues": [
    {
      "iid": 138, "project_id": 110,
      "project_path": "UniData/630-campaign", "full_ref": "UniData/630-campaign#138",
      "web_url": "...", "title": "...", "state": "opened", "due_date": "2026-06-30",
      "labels": ["Sprint::S3"], "assignees": [{"username": "xiaowj"}],
      "author": {"username": "root"}, "created_at": "...", "updated_at": "...",
      "user_notes_count": 0, "merge_requests_count": 0
    }
  ]
}
```

> **关键**：跨 project milestone 下不同 project 的 iid 会重复（每个 project 都从 1 开始），所以渲染时 IID 列必须用 `full_ref`（带 project_path 前缀，如 `UniData/630-campaign#138`）而非裸 iid。

### 3. 格式化展示（渲染职责分工）

**契约：脚本输出完整准确的 JSON，Claude 拿 JSON 后渲染看板。**

- 脚本（`gitlab-issue.sh`）职责：自动分页保证数据完整（无截断）、milestone JSON 含已聚合的 summary（by_project / opened / closed 计数）、list/milestone 的 `--format json` 是主输出契约。
- Claude（本 skill）职责：拿 JSON 后按 deadline 分组渲染看板（脚本不再把 P0/P1/P2 表格作为主输出）；`list --format table` 仍提供快速查看 P0/P1/P2 表（向后兼容）。

#### 3.1 数据获取

`list --all` 的人类可读表格不含 deadline 列；做看板时用 **JSON 输出**拿完整字段：

```bash
bash ${HARNESS_ROOT:-.claude}/skills/issue-board/scripts/gitlab-issue.sh list --all --format json
```

JSON 含 `due_date` / `labels` / `severity` / `assignees` / `updated_at` 等字段，由 Claude 自行渲染分组。

#### 3.2 看板分组规则（按 Deadline）

以**今天**为基准计算倒计时（`due_date − today`），按下表分组；每组内按 deadline 升序排列：

| 分组 | 图标 | 阈值（倒计时天数） |
|------|------|------------------|
| 已过期 | 🔴 | due_date < 今天 |
| ≤ 3 天 | 🟠 | 0 ~ 3 天 |
| 4-7 天 | 🟡 | 4 ~ 7 天 |
| 8-14 天 | 🟢 | 8 ~ 14 天 |
| ≥ 15 天 | 🔵 | ≥ 15 天 |
| 未设 deadline | ⚪ | due_date 为空 |

> 分组名只用数字范围，**禁止使用"本周/下周/后续"等相对时间词**（避免歧义、便于跨人跨日解读）。

#### 3.3 表格列约定

| 列 | 说明 |
|----|------|
| IID | 纯数字格式（如 `265`），**不加 `!` 前缀**（`!` 在 GitLab 是 MR 记号） |
| P | P 级别（从 `labels` 中匹配 P0/P1/P2）；无则标 `—` |
| Deadline | `M/DD` 格式；已过期项用 `~~删除线~~` 标注 |
| 倒计时 | "X 天"；已过期用 "过期 X 天"；8 天及以后可省略此列以紧凑 |
| 任务 | 从标题解析的任务编号（如 `B-02`、`S0-13`） |
| 标题 | Issue 标题（可去除编号前缀以紧凑展示） |
| 状态 | 进行中（最近 `updated_at` ≤ 24h 或有 `in-progress` 标签）/ 已完成待关 / 未启动 |

#### 3.4 关键风险小结（必出）

看板末尾必须输出 2-4 条风险点，参考维度：
- 已过期任务数 + 处置建议（关闭 / 续期 / 重新定义 deadline）
- 紧急任务的依赖链卡点（如 B-02 依赖 S0-13）
- 当前进行中任务及其阻塞点

#### 3.5 P0/P1/P2 与维度过滤（按需）

PM 显式要求时（如"只看 P0"、"过滤 security 维度"），先 `--severity` / `--dimension` 过滤，再按 deadline 分组展示：

```bash
bash ${HARNESS_ROOT:-.claude}/skills/issue-board/scripts/gitlab-issue.sh list --severity P0 --format json
bash ${HARNESS_ROOT:-.claude}/skills/issue-board/scripts/gitlab-issue.sh list --dimension security --format json
```

#### 3.6 示例片段

```markdown
## 任务看板（共 N 项开放）

> 今天：2026-06-13

### 🔴 已过期（M 项）
| IID | P | Deadline | 倒计时 | 任务 | 标题 | 状态 |
|-----|---|---------|-------|------|------|------|
| 52 | — | ~~6/11~~ | 过期 2 天 | S0-13 | 部署环境信息确认 | 🔄 进行中 |

### 🟠 ≤ 3 天
| IID | P | Deadline | 倒计时 | 任务 | 标题 |
|-----|---|---------|-------|------|------|
| 54 | P0 | 6/15 | 2 天 | B-01 | 一键部署脚本（Docker Compose 单机版） |

...（其他分组：🟡 4-7 天 / 🟢 8-14 天 / 🔵 ≥ 15 天 / ⚪ 未设，同形式）...

## 关键风险
- 4 项已过期：S0 阶段全部过期，建议确认是否已完成可关闭
- B-01 还剩 2 天：硬件虽申请但 B-01 是单机版，可不等硬件先做
```

### 4. PM 操作

PM 可在看板展示后执行以下操作：

#### 4.1 分派给 AI Agent 修复

当 PM 指定修复某个 Issue（如"修复 !3"、"AI 修复 !3"）时：

1. **读取 Issue 详情**：
   ```bash
   bash ${HARNESS_ROOT:-.claude}/skills/issue-board/scripts/gitlab-issue.sh get <iid>
   ```

2. **分析问题维度，确定修复角色**：

   | 维度标签 | 分派角色 | Agent 类型 |
   |---------|---------|-----------|
   | `ai-dimension:security` | Architect + Developer | 先 Architect 设计方案，再 Developer 实现 |
   | `ai-dimension:architecture` | Architect | Architect 设计修复方案 |
   | `ai-dimension:code` | Developer | Developer 直接修复 |
   | `ai-dimension:test` | Tester | Tester 补充/修复测试 |
   | `ai-dimension:docs` | Reviewer | Reviewer 补充文档 |

3. **分派 Agent 修复**：
   ```
   Agent(subagent_type="Developer", prompt="修复 Issue !3：{问题描述}
   - 问题维度：code
   - 修复后提交代码，commit message 格式：[BUG-xxx] BUG {模块}[AI-{git_user}.Developer] 修复{问题描述}")
   ```

4. **提交 MR 并关联 Issue**：MR 描述含 `Closes #iid`

5. **更新 Issue 指派人**：
   ```bash
   bash ${HARNESS_ROOT:-.claude}/skills/issue-board/scripts/gitlab-issue.sh update <iid> --assignee {git_user}
   ```

6. **评论提醒提交者验证并关闭**（必做，不可省）：

   修复推送后必须在 issue 上追加一条评论，明确告知下游验证方法与关闭时机，否则下游不知道下一步动作：

   ```bash
   bash ${HARNESS_ROOT:-.claude}/skills/issue-board/scripts/gitlab-issue.sh comment <iid> --body '评论内容'
   ```

   评论必须包含三要素（缺一不可）：

   | 要素 | 内容 | 示例 |
   |------|------|------|
   | 修复 commit | 框架版本定位锚点 | `commit 639a587 [190] BUG daily-report` |
   | 验证步骤 | 下游如何确认修复生效 | 拉新版本 → 跑 `/daily-report` → 观察 `concern_stats` 是否准确 |
   | 关闭指引 | 明确"验证通过后关闭本 issue" | 「验证通过后**关闭本 issue**」 |

   **必须 @mention 提交者**（从 issue `author.username` 取，格式 `@username`），这是下游收到 GitLab 通知、追踪 issue 后续的唯一渠道。

   issue 保持 **open** 状态，由下游提交者验证后自行关闭（AI 不代为关闭——AI 无法判断下游是否已升级到含修复的版本）。

   模板：

   ```markdown
   ## 补充：验证 & 关闭指引

   @{username} 请在修复发布到你的项目后验证：

   1. 拉取最新框架版本（含 commit `{sha}`）
   2. {具体复现/验证步骤}
   3. 验证通过后**关闭本 issue**（状态 → 关闭）
   ```

#### 4.2 指派给人类团队成员

当 PM 要指派 Issue 给人类成员（如"把 !4 指给 zhangsan"）：

1. **更新 GitLab 指派人**：
   ```bash
   bash ${HARNESS_ROOT:-.claude}/skills/issue-board/scripts/gitlab-issue.sh update <iid> --assignee <username>
   ```

2. **输出指派确认**（必须展示给 PM）：
   ```
   Issue {iid} 已指派给 {username}
   提醒：需通知 {username} 在 GitLab 上查看 Issue 详情并处理
   ```

3. **批量指派**（如"把所有 P0 指给 wangzk"）：逐个执行 `update --assignee`，完成后汇总结果。

#### 4.3 按优先级批量分派

当 PM 要求批量处理（如"分派所有 P0"、"处理 P1"）：

1. **按优先级列出未指派 Issue**：
   ```bash
   bash ${HARNESS_ROOT:-.claude}/skills/issue-board/scripts/gitlab-issue.sh list --severity P0
   ```

2. **生成分派方案表格展示给 PM 确认**：

   | IID | 维度 | 标题 | 建议分派 | 类型 |
   |-----|------|------|---------|------|
   | 3 | security | SQL注入风险 | Architect → Developer | AI 修复 |
   | 5 | code | 命名不规范 | zhangsan | 人工处理 |

   > 建议规则：security/architecture → AI Agent 修复；code/test/docs → 优先 AI，PM 可改为人工

3. **PM 确认后逐个执行**：AI 修复的调用 Agent，人工处理的执行 `update --assignee` 并提醒通知。

#### 4.4 添加评论

```bash
bash ${HARNESS_ROOT:-.claude}/skills/issue-board/scripts/gitlab-issue.sh comment <iid> --body '评论内容'
```

**关闭 Issue 前必须先添加评论**，说明处理结论（确认无问题 / 修复 commit / 被其他修复覆盖等），**必须 @mention 提交者用户名**（从 issue 的 `author.username` 获取，格式 `@username`），不得无评论直接关闭。@mention 是下游提交者收到 GitLab 通知、追踪 issue 后续的唯一渠道。

#### 4.5 关闭 Issue

```bash
bash ${HARNESS_ROOT:-.claude}/skills/issue-board/scripts/gitlab-issue.sh close <iid> --mr !<mr_iid>
```

#### 4.6 更新 Issue 标签

```bash
bash ${HARNESS_ROOT:-.claude}/skills/issue-board/scripts/gitlab-issue.sh update <iid> --labels "P2,ai-detected,ai-dimension:code"
```

### 5. 交互流程

**示例一：批量分派**

```
PM: 看板
AI: (按 deadline 分组展示：🔴 已过期 / 🟠 ≤3 天 / 🟡 4-7 天 / 🟢 8-14 天 / 🔵 ≥15 天，含 P 级别列，末尾输出关键风险)
PM: 分派所有 P0
AI: 读取 P0 Issue 列表，生成分派方案：
    | IID | 维度 | 标题 | 建议分派 | 类型 |
    | 3   | security | SQL注入 | Architect → Developer | AI 修复 |
    | 5   | code | 命名不规范 | zhangsan | 人工处理 |
    请确认分派方案。
PM: 确认
AI: 执行中...
    Issue 3 → Developer Agent 修复中...
    Issue 5 → 已指派给 zhangsan，需通知其在 GitLab 查看
    Issue 3 修复完成，已创建 MR !88（Closes #3）
    批量分派完成。
```

**示例二：单个 AI 修复**

```
PM: 修复 !7
AI: Issue 7: [CI-AI] P1: 命名不规范 in OrderService
    维度: code → 分派 Developer
    (调用 Developer Agent 修复)
    修复完成，是否创建 MR？
PM: 是
AI: 已创建 MR !90（Closes #7）
```

**示例三：指派给人类**

```
PM: 把 !8 指给 wangzk
AI: Issue 8 已指派给 wangzk。
    提醒：需通知 wangzk 在 GitLab 上查看 Issue 详情并处理。
```

## 执行规则

1. **凭证安全**：`.gitlab-config` 必须加入 `.gitignore`，不得提交到仓库
2. **只读优先**：展示看板时只执行 `list` 和 `get`，不修改任何 Issue
3. **确认后操作**：修复、指派、关闭操作需 PM 明确确认后执行。**关闭 Issue 前必须先添加评论说明处理结论**
4. **角色匹配**：修复时严格按维度→角色映射表分派，不跳过 Architect 对安全/架构问题的审查
5. **MR 关联**：修复后的 MR 描述必须包含 `Closes #iid`，确保合入后自动关闭 Issue
6. **批量操作先出方案**：批量分派前必须先生成分派方案表格，PM 确认后再执行
7. **人工指派必须提醒**：指派给人类成员后，必须提醒 PM 通知对应人员在 GitLab 上查看
8. **失败处理**：API 调用失败时报告错误原因（凭证过期、网络问题、权限不足），不静默跳过
9. **关闭时必须 @mention 提交者**：关闭 Issue 的评论必须包含 `@提交者用户名`（从 issue `author.username` 获取），这是下游用户收到 GitLab 通知、追踪 issue 后续的唯一渠道。修复 commit 也应注明，方便下游确认升级版本
10. **修复后必发"验证 & 关闭"评论**：AI 完成修复推送后，**必须**追加一条评论（独立于根因说明评论），包含三要素：修复 commit + 验证步骤 + 「验证通过后关闭本 issue」指引，并 @mention 提交者。issue 保持 open，由下游验证后自行关闭。**AI 不代为关闭**——AI 无法判断下游是否已升级到含修复的版本。
11. **看板默认按 deadline 分组**：展示时必须按 deadline 分组（🔴 已过期 / 🟠 ≤3 天 / 🟡 4-7 天 / 🟢 8-14 天 / 🔵 ≥15 天 / ⚪ 未设），**分组名只用数字范围，禁止使用"本周/下周/后续"等相对时间词**；每组按 deadline 升序，表格必须含 `P` 列（取自 `labels` 中的 P0/P1/P2，无则标 `—`），末尾必出关键风险小结；P0/P1/P2 仅在 PM 显式要求时���为过滤条件，不再作为默认分组维度
10. **看板默认按 deadline 分组**：展示时必须按 deadline 分组（🔴 已过期 / 🟠 ≤3 天 / 🟡 4-7 天 / 🟢 8-14 天 / 🔵 ≥15 天 / ⚪ 未设），**分组名只用数字范围，禁止使用"本周/下周/后续"等相对时间词**；每组按 deadline 升序，表格必须含 `P` 列（取自 `labels` 中的 P0/P1/P2，无则标 `—`），末尾必出关键风险小结；P0/P1/P2 仅在 PM 显式要求时作为过滤条件，不再作为默认分组维度
