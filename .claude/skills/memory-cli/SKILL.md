---
name: memory-cli
version: 1.0.0
description: 记忆增删改查、类型分治路由、状态管理、校验剪枝。当需要记录开发经验、查询已有记忆、清理过时记忆时触发。
user_invocable: true
---

# 记忆管理 Skill

## 双层存储架构

按记忆性质分治，解决跨环境同步问题：

| 类型 | 性质 | 存储位置 | git 跟踪 | 目录 |
|------|------|---------|---------|------|
| `user` | 个人偏好（协作风格、关注点） | auto-memory（`~/.claude/projects/...`） | 否 | 跟人走 |
| `feedback` | 行为指导（禁止/鼓励的做法） | auto-memory（`~/.claude/projects/...`） | 否 | 跟人走 |
| `project` | 项目状态（进度、决策、约束） | `{project_root}/.harness/memory/` | **是** | 跟项目走 |
| `reference` | 外部资源指针（文档链接、工具地址） | `{project_root}/.harness/memory/` | **是** | 跟项目走 |

**写入时自动路由**：
- `type: user` 或 `type: feedback` → 写入 auto-memory 目录
- `type: project` 或 `type: reference` → 写入 `.harness/memory/`

**读取时合并**：两个存储位置的 MEMORY.md 索引都会被加载到上下文。

## 扩展字段

auto-memory 原生 frontmatter：`name`、`description`、`type`。

本 Skill 新增 2 个字段：

| 字段 | 值域 | 说明 |
|------|------|------|
| `status` | `unverified` / `verified` / `stale` | 默认 `unverified`，人类复核后改为 `verified` |
| `module` | 自由文本，建议用项目 CLAUDE.md 中定义的模块名 | 记忆所属模块，用于按模块筛选 |

**frontmatter 示例**：
```yaml
# feedback 类型 → auto-memory
---
name: Push Approval Strict
version: 1.0.0
description: AI 不得自行创建推送审批令牌
type: feedback
status: verified
module: llm-gateway
---
```
```yaml
# project 类型 → .harness/memory/
---
name: 融合引擎空指针风险
version: 1.0.0
description: 多源路由返回 null 未做防御
type: project
status: unverified
module: fusion-engine
---
```

## .harness/memory/ 结构

```
.harness/memory/
├── MEMORY.md                            # 索引文件（每条一行）
└── {type}_{title-slug}.md               # 记忆文件
```

**索引格式**：`- [Title](filename.md) — 一句话摘要`

## 操作

### add — 记录经验

**步骤**：
1. 按下方决策树判定 type
2. 根据 type 确定目标目录（auto-memory 或 `.harness/memory/`）
3. 若目标目录不存在：`mkdir -p` 创建目录，Write 创建 MEMORY.md（含 `# MEMORY.md` 标题行）
4. 生成文件名：`{type}_{简短英文slug}.md`
5. Write 创建记忆文件，Edit 追加索引行到对应 MEMORY.md

**类型判定决策树**（按顺序判断，命中即停）：

```
信息内容是否指向一个外部系统/工具/文档的标识符或地址（URL、端点、项目名、文档编号），
且记忆的目的是引导查阅该外部资源？
  └─ 是 → reference（存 .harness/memory/）
  示例："监控面板在 grafana.internal/d/api-latency"、"pipeline bugs 在 Linear INGEST"

信息是否描述"这个用户/PM 喜欢怎样协作"或"AI 在协作流程中的行为偏好"？
  注：架构层面的约束（如"禁止在 API 层写业务逻辑"）不属于此节点，归 project。
  └─ 是 → feedback（存 auto-memory）
  示例："commit 前必须等 PM 说'提交'"、"PM 不喜欢太多注释"

信息是否描述用户自身的角色、背景、技能水平？
  └─ 是 → user（存 auto-memory）
  示例："用户是 Go 工程师，第一次做 Java"

其余情况 → project（存 .harness/memory/）
  包括：技术约束、架构规范、已知缺陷、性能特征、边界条件、非显而易见的行为
  含"禁止"字样的架构约束归此类，不归 feedback
  示例："融合引擎多源路由返回 null 未做防御"、"CI 连续失败 3 次触发熔断"
```

**判定原则**：拿不准时默认 project。project 多一条无害，feedback 归错类会导致项目约束无法跨环境同步。

**内容规范**：
- 必须写：具体可操作的事实（"X 在 Y 条件下会 Z"）、非显而易见的边界条件和陷阱
- 禁止写：可从代码推导的信息、git 历史、已文档化在 CLAUDE.md 的内容

**自动填充**：`status: unverified`、`module: {当前任务模块}`

### get / list / update / delete

使用 Read/Write/Edit 工具操作对应目录的文件。list 按需读取两个 MEMORY.md 后按 `module`/`status`/`type` 过滤。

**delete 约束**：verified 记忆不得由 AI 单方面删除。正确的遗忘流程是先 update status → stale，再由 prune 统一清理（需 PM 确认）。unverified 记忆可由 AI 直接删除。

**update 状态迁移规则**：
- `unverified` → `verified` ✅
- `unverified` → `stale` ✅
- `verified` → `stale` ✅
- `stale` → 任何状态 ❌
- `verified` → `unverified` ❌

**跨类型迁移**：禁止通过 update 修改 `type` 字段（type 决定存储目录，修改 type 等于跨目录迁移）。正确的迁移方式：在目标目录 add 新记忆（复用正文）→ 从源目录 delete 旧记忆。

### prune — 剪枝清理

先展示清理列表，等 PM 确认后执行删除。扫描两个存储目录。

**清理条件**（满足任一）：
- `status: stale`
- `status: unverified` 且创建超过 30 天
- 创建超过 60 天（任何状态）

### validate — 校验

抽查两个目录中最近 10 条记忆，检查以下规则：

| 规则 | 级别 |
|------|------|
| frontmatter 含 name/description/type | ERROR |
| type 枚举值合法 | ERROR |
| status 枚举值合法（如有） | ERROR |
| 正文不超过 5 行 | WARN |
| MEMORY.md 索引行与文件一一对应 | ERROR |
| 总条目数 ≤ 200（每个目录独立计数） | WARN |

## 何时使用

| 场景 | 操作 |
|------|------|
| 开发中发现非显而易见的经验 | add（type=project） |
| 发现协作偏好或行为纠正 | add（type=feedback） |
| 查看模块已知经验 | list --module {模块名} |
| 确认 AI 记忆准确 | update status → verified |
| 代码重构后记忆失效 | update status → stale |
| 周维度维护 | prune + validate |

## 未验证记忆使用限制

`status: unverified` 的记忆仅供参考，不得作为决策依据。引用未验证记忆执行关键操作前，必须提示 PM 确认。
