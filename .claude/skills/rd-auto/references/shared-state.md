# Shared-State 与 rd 命令协作

> 跨角色状态共享机制，以及 orchestrator 与 rd CLI 的边界。Read 本文件了解详细协议。

## Shared-State 目录

`.harness/shared-state/<change-name>/` 跨角色共享 JSON 状态：

| 文件 | 写入者 | 读取者 | 用途 |
|------|--------|--------|------|
| `concerns.json` | Reviewer（code-review/design-review） | Developer（rework） | P0/P1/P2 问题列表，结构化存储，每条落实到人（author） |
| `interface-changes.yaml` | Architect（propose） | Developer（implement） | 接口变更跨角色共享 |
| `task-status.json` | Developer（implement） | Reviewer | 任务完成状态（fanout 时为并行编排预留） |

## concerns.json 结构

规范格式为分组 `{p0:[],p1:[],p2:[]}`（与 `harness-rules.yaml` schema、实际样本一致）：

```json
{
  "p0": [
    {
      "id": "C001",
      "severity": "P0",
      "title": "阻断级问题标题",
      "status": "open | resolved | dismissed",
      "file": "design.md",
      "line": "§接口定义",
      "raised_by": "reviewer",
      "author": "wangzk",
      "created_at": "2026-06-14T..."
    }
  ],
  "p1": [
    {
      "id": "C002",
      "severity": "P1",
      "title": "非阻断问题标题",
      "status": "open | resolved | dismissed",
      "file": "tasks.md",
      "line": "WI-3",
      "raised_by": "developer",
      "author": "wangzk",
      "created_at": "2026-06-14T..."
    }
  ],
  "p2": [
    {
      "id": "C003",
      "severity": "P2",
      "title": "改进建议",
      "status": "open | resolved | dismissed",
      "file": "spec.md",
      "line": "§3",
      "raised_by": "reviewer",
      "author": "wangzk",
      "created_at": "2026-06-14T..."
    }
  ]
}
```

> **author 字段 = 问题责任人（强制）**：每条 concern 必填 `author`（git 用户名，与 collect-ai.js `--user` 匹配），用于日报按用户过滤 + 问题落实到人。
> **write-shared-state 写入时缺失 author 直接拒绝**（`normalizeConcerns` 校验）；旧数据无 author 时 collect-ai.js 读取端保留并打 warn，不丢弃，但日报无法将该问题落实到人——写入端（Reviewer/Debate agent）必须填 `author`。

> 兼容性：advance 通过 `countOpenP0FromConcerns` 读取时**同时容忍遗留扁平格式** `{concerns:[{severity,status,...}]}`（按 `severity==='P0' && status!=='resolved'` 计数）。新代码请写分组格式。

## 路由与 P0 Veto 机制

advance 路由判据统一是 **open P0 数量**（`status !== 'resolved'` 的 P0 项）：

- **DONE_WITH_CONCERNS**：open P0 == 0 → 自动推进（标 `[auto-promoted: non-P0 concerns]`）；open P0 > 0 → `evaluate_concerns` + `needs_pm`（停）。
- **NEEDS_PM**（Worker 显式）：停，`needs_pm`（不递增熔断计数）。
- **code-review DONE** P0 veto：open P0 > 0 → rework（与 score 无关，一票否决）。
- P1/P2 **不阻断 advance**，由 code-review scoring 兜底（score∈[80,90) 且 P1≤2 条件通过，reviewer 修 P1）。

### code-review DONE 的完整路由

- P0 count > 0 → rework（routeRework by dimension）
- P0 count = 0 且 score >= 90 → archive（debate 跳过）
- P0 count = 0 且 score in [80, 90) → archive（reviewer 修 P1，P1≤2）
- P0 count = 0 且 score in [75, 80) → debate
- P0 count = 0 且 score < 75 → rework

## 命令

```bash
# 读取（filter by key/status）
node $SCRIPT read-shared-state <change> --key concerns --status open

# 写入
node $SCRIPT write-shared-state <change> --key concerns --json '<JSON>'

# 标记单条 concern 解决
node $SCRIPT resolve-concern <change> --concern-id C001
```

> **resolve 时机（必须）**：Developer/Reviewer 修复某条 concern 对应的问题后，**必须**调用 `resolve-concern <change> --concern-id <id>` 将其标记 `resolved`——否则该问题仍计入 open：会误触发 advance 的 P0 否决（`countOpenP0FromConcerns` 按 `status !== 'resolved'` 计数），且 daily-report 的 concern_stats 会把已修复问题统计为仍未决（失真）。
>
> **写入强制归一化**：`write-shared-state --key concerns` 将 AI 传入的任意格式（裸数组 / 包裹 `{concerns}` / 分组 `{p0,p1,p2}`）**归一化为规范分组 `{p0,p1,p2}`**，并校验每条必填字段（`id` / `severity`(P0|P1|P2) / `author`(问题责任人) / `status`(open|resolved|deferred|dismissed) / `description`），非法输入或**缺 author 直接拒绝**——AI 无法再自由输出不符合要求的格式（`lib/concerns.js` 的 `normalizeConcerns`）。
>
> **读取兼容**：`resolve-concern` / `read-shared-state --status` / `countOpenP0FromConcerns` / collect-ai 仍同时容忍分组 `{p0,p1,p2}`、遗留扁平 `{concerns:[...]}`、裸数组 `[...]` 三种历史结构（`lib/concerns.js` 统一处理，写回时保留原顶层形状）。
>
> **读侧 status 容错**（issue !259）：读侧（collect-ai `collectConcernStats` / advance `countOpenP0FromConcerns`）对 resolved 同义词（`fixed`/`closed`/`done`/`已修复`/`已解决`/`已关闭`）容错**计为已关闭**并打一次性 WARNING（提示用 `resolve-concern` 修正，禁止直改文件）；未知 status 词（如 `wontfix`）按**未决（open）**处理并告警。`deferred`/`dismissed` 维持不计已关闭（推迟 ≠ 解决）。写入门禁词表**不变**（`normalizeConcerns` 仍只认 `open/resolved/deferred/dismissed`），读侧只归一化内存判断，不回写文件。

## 与 rd 命令的关系

- **sub-agent 内部**调用 rd CLI（`rd new change` / `rd status` / `rd apply` 等）做制品管理
- **orchestrator** 只管调度决策，不替代 rd 的制品管理
- 边界：rd 负责"创建/读取 spec 制品文件"，orchestrator 负责"决定下一步派谁、传什么 context"
