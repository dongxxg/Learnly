---
name: daily-report
version: 1.0.0
description: 通过看板查询任务（个人/全员/他人）和提交/查询日报。Triggers: 填写日报, 查询日报, 个人看板, 我的任务, 看板任务, 查某人任务, 提交日报, my tasks, submit report, /daily-report
---
# Taskboard Daily 任务 + 日报技能

通过 taskboard MCP 查询任务、提交日报。输出 JSON 六段格式（`date/git_username/repo/git/kanban/ai`），符合 daily-report.schema.json。

**约束**：


| 约束                | 原因                                                   |
| ----------------- | ---------------------------------------------------- |
| **MCP 工具只有模型能调**  | Node 脚本只做渲染/校验/采集                                    |
| **禁止 `2>&1` 合并流** | schema 校验失败时 stderr 单行报错，合并会污染目标文件                   |
| **MD 不嵌入 JSON**   | `create-project-report` 原生支持 markdown + jsonData 双字段 |
| **用户沟通一律用"看板"**   | MCP API 叫 `project`，用户侧只认"看板"                        |


**前置条件**：taskboard MCP server 已配置，`mcp__taskboard__whoami` 返回 Seeder 用户身份（readwrite 令牌才能提交日报）。

**作者身份**：通过 `whoami.js --field user` 从令牌 email 本地名解析（如 `admin@unitechs.com → admin`），不依赖本地 git config。

## 执行步骤

### 0a. 看板选择（所有模式通用）

```
读取 daily-report-tmp/.active-project
├─ 存在 → read-project 验证 → 有效且未归档则用，null/归档则删除并重走
└─ 不存在 → list-projects → 过滤归档看板 → 列出供用户选择 → 写入 .active-project（projectId|看板名）
```

- `list-projects` 传 `includeArchived: false` 过滤归档看板
- 用户说"切换看板" / "用 X 看板" → 重新走 0a。**不要 AskUserQuestion，直接列出。**

### 0b. 模式菜单

0a 完成后输出：

```
当前看板：<看板名>
使用AskUserQuestion询问用户进行选择
1. 提交/更新日报  
2. 我的任务  
3. 全员任务
4. 查询日报  
5. 他人任务  
6. 切换看板
```

| 输入                        | 模式        |
| ------------------------- | --------- |
| `1` / `提交日报` / `写日报`      | §4 提交日报   |
| `2` / `我的任务` / `my tasks` | §1 个人任务   |
| `3` / `全员任务`              | §2 看板全员任务 |
| `4` / `查询日报`              | §5 查询日报   |
| `5` / `他人任务`              | §3 他人任务   |
| `6` / `切换看板`              | 重新执行 §0a  |


用户选择后直接走对应模式，**不再二次确认**。

---

### 1 个人任务

1. 执行 0a
2. `list-tasks({projectId, assignedToMe: true, verbose: true})` — ⚠️ `assignedToMe:true` 不能省
3. `list-task-statuses({projectId})` 拿 statusId → name/color 映射
4. 渲染表格：`| Code | 标题 | 状态 | 优先级 | 截止 |`

### 2 看板全员任务

1. 执行 0a
2. `list-tasks({projectId, verbose: true})` + `list-task-statuses` + `list-project-members`
3. 按负责人分组渲染

### 3 他人任务

1. 执行 0a
2. 解析目标人名 → `list-project-members` 匹配 userId
3. `list-tasks({projectId, verbose:true})`，内存过滤 `assigneeId === userId`

### 4 提交日报

**Step 0 — Uni-AURI 版本门禁（强制，无豁免）**：

```bash
node $SKILL_DIR/scripts/check-harness-version.js
```

exit 0 静默通过（源仓库豁免、网络 fail-open 内置于脚本）；exit 1 → 原样向用户展示 stderr 提示（含 `/upgrade-harness` 指引），**终止提交流程**，升级并重启 session 后才能继续。

**Step 1** — 执行 0a。**归档看板禁止提交日报**，检测到归档时提示用户切换看板。

**Step 2 — 采集任务**（curl REST 快照，一次拿全；任务行数据**不进模型上下文**）：

```bash
DATE=$(date +%F)
GIT_USER=$(node $SKILL_DIR/scripts/whoami.js --field user)
PAT=$(node $SKILL_DIR/scripts/whoami.js --field token)
MCP_URL=$(node $SKILL_DIR/scripts/whoami.js --field url)
SNAP_URL="${MCP_URL%/api/mcp}/api/projects/$PROJECT_ID/report-input?assignee=me"
SNAP="daily-report-tmp/$DATE-$GIT_USER.snapshot.json"

HTTP_CODE=$(curl -sS --connect-timeout 10 --max-time 60 -w "%{http_code}" -o "$SNAP" \
  -H "Authorization: Bearer $PAT" "$SNAP_URL")
if [[ ! "$HTTP_CODE" == 2* ]]; then echo "❌ 快照采集失败 (HTTP $HTTP_CODE): $(cat "$SNAP")" >&2; exit 1; fi

# 拆分为 synthesize-tasks.js 的三个 raw 输入（格式 = MCP 工具返回原样）
GROUP=$(node -e '
const fs=require("fs");fs.mkdirSync("daily-report-tmp",{recursive:true});
const s=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
const w=(n,d)=>fs.writeFileSync("daily-report-tmp/"+n,JSON.stringify(d));
w(process.argv[2],s.tasks.rows??s.tasks);w(process.argv[3],s.statuses);w(process.argv[4],s.members);
process.stdout.write(s.myMembership?.groupName??"");
' "$SNAP" "$DATE-$GIT_USER.raw-tasks.json" "$DATE-$GIT_USER.raw-statuses.json" "$DATE-$GIT_USER.raw-members.json")
```

> 回退：若快照端点不可用（404/部署未含），退回 MCP 采集——`list-tasks({projectId, assignedToMe: true, verbose: true})` + `list-task-statuses({projectId})` + `list-project-members({projectId})` + `read-project({projectId})` + `read-my-membership({projectId})`（GROUP = membership?.groupName ?? ""），结果落盘同名 raw 文件。

**Step 3 — 合成 tasks.json**：

```bash
node $SKILL_DIR/scripts/synthesize-tasks.js \
  --tasks @daily-report-tmp/$DATE-$GIT_USER.raw-tasks.json \
  --statuses @daily-report-tmp/$DATE-$GIT_USER.raw-statuses.json \
  --members @daily-report-tmp/$DATE-$GIT_USER.raw-members.json \
  --user "$GIT_USER" --assignee-filter "$GIT_USER" \
  --output daily-report-tmp/$DATE-$GIT_USER.tasks.json
```

`--assignee-filter` 是 issue !147 的二次防线（即使 MCP 漏了 assignedToMe 也会按 userId 过滤）。

**Step 4 — 采集 git + ai**：

```bash
GIT_USER=$(node $SKILL_DIR/scripts/whoami.js --field user)
node $SKILL_DIR/scripts/collect-all.js --date $DATE --user "$GIT_USER" --output-dir daily-report-tmp
```

多仓库日报：在项目根创建 `.harness-projects` 列出子仓库路径（需自带 `.claude/`）。

> pipeline 段数据来自 `.harness/tasks/*/pipeline-state.json`，由 `rd-auto` skill 的 `orchestrator.js mark-dispatch` 写入。

**Step 5 — 渲染 MD + JSON**：

```bash
node $SKILL_DIR/scripts/render-report.js \
  --date $DATE --user "$GIT_USER" --repo "$REPO" --branch "$BRANCH" --group "$GROUP" \
  --tasks @daily-report-tmp/$DATE-$GIT_USER.tasks.json \
  --git "<collect-all.js stdout .git_arg>" --ai "<collect-all.js stdout .ai_arg>" \
  --output daily-report-tmp/$DATE-$GIT_USER.md \
  --json-output daily-report-tmp/$DATE-$GIT_USER.json
```

> `--git` / `--ai` 参数支持换行分隔多文件路径（兼容旧版逗号分隔）。

输出 JSON 顶层：`date/git_username/repo/git/kanban/ai`。kanban 段含 `stats`（6 字段）和 `deadline_calendar`（5 桶：overdue/today/tomorrow/day_after/unscheduled）。

**Step 6 — 看板任务状态回顾 + 整改建议**

按场景分组输出，用户选择后调对应 MCP 工具。

#### 场景 A — 逾期未完成（deadline_calendar.overdue 中非 ✅）

```
⚠️ 逾期未完成：630-126 E2E 自主运维验收 [6/28 到期，⬜ 未开始]
   整改：更新状态为"进行中" + 追加备注说明阻塞原因
   操作：A) 更新状态+备注  B) 仅备注  C) 跳过
```

#### 场景 B — 有风险任务

```
🔴 有风险：630-xxx [6/30 到期，🟡 有风险]
   整改：1) 降级方案  2) 求助方向
   操作：A) 追加风险备注  B) 更新 deadline  C) 跳过
```

#### 场景 C — 今日到期未完成

```
📌 今日到期：630-131 合规证据链打包 [6/30 到期，⬜ 未开始]
   整改：标记"有风险"+备注计划，或拆分子任务
   操作：A) 标记有风险+备注  B) 跳过
```

#### 操作汇总


| 操作     | MCP 工具                                                                                                                                  |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| 更新状态   | `update-task-status({taskId, projectId, statusId})`                                                                                     |
| 标记风险   | `update-task-status({taskId, projectId, statusId: "<有风险 statusId>"})`                                                                   |
| 添加备注   | `add-task-comment({projectId, taskId, content})`                                                                                        |

> ⛔ **完成态门禁**：把任务移到完成（terminal）状态受服务端证据门禁约束（须有附件或评论，或带 `completionOverride.reason` 豁免），被拦时按 `.claude/rules/task-completion-gate.md` 三选一处置。本 skill 的"标记风险/进行中"均为非完成态移动，不触发门禁。


**Step 7 — 预览确认**：渲染 MD 输出到屏幕，等用户确认。

**Step 8 — 提交日报**（用 curl 不用 MCP，避免 15KB JSON 经模型 token 损坏）：

```bash
PAT=$(node $SKILL_DIR/scripts/whoami.js --field token)
MCP_URL=$(node $SKILL_DIR/scripts/whoami.js --field url)
REPORTS_URL="${MCP_URL%/api/mcp}/api/reports"

RESPONSE=$(curl -sS --connect-timeout 10 --max-time 60 -w "\n%{http_code}" -X POST "$REPORTS_URL" \
  -H "Authorization: Bearer $PAT" \
  -F "markdown=@daily-report-tmp/$DATE-$GIT_USER.md" \
  -F "jsonData=@daily-report-tmp/$DATE-$GIT_USER.json" \
  -F "projectId=$PROJECT_ID" -F "author=$GIT_USER" \
  -F "reportDate=$DATE" -F "title=$DATE $GIT_USER 日报" -F "repo=$REPO" \
  -F "harnessVersion=$(head -1 .harness/.harness-version)")

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')
if [[ "$HTTP_CODE" == "409" ]]; then echo "⛔ 版本门禁拒收: $BODY" >&2; exit 1; fi
if [[ ! "$HTTP_CODE" == 2* ]]; then echo "❌ 提交失败 (HTTP $HTTP_CODE): $BODY" >&2; exit 1; fi
REPORT_ID=$(echo "$BODY" | node -e "let s=''; process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).reportId||'')}catch{console.log('')}})")
if [ -z "$REPORT_ID" ]; then echo "❌ 响应 2xx 但缺 reportId: $BODY" >&2; exit 1; fi
```

**Step 9 — 输出确认**：

```
✅ 日报已提交
- 看板：<name>  日期：<DATE>  作者：<email>  reportId: <ID>
- 本地副本：daily-report-tmp/<DATE>-<user>.md / .json
```

### 5 查询日报

1. 执行 0a
2. `list-project-reports({projectId, author?, limit: 20})` → 渲染列表
3. 用户选某条后 `read-project-report({projectId, reportId})` → 展示 markdown / json_data

